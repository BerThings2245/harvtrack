"""
HarvTrack API-level test suite (Flask test client, fresh seeded SQLite database).
server.py reads its database from the HT_DB environment variable, so these tests
never touch your real database:
    app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('HT_DB', 'sqlite:///harvtrack.db')
Run:  pip install pytest ; pytest -v test_harvtrack_api.py   (place this file next to server.py)
Each test is tagged with the TC-xx / SEC-xx id used in Chapter IV, Table 4.2.
Every request is made as a logged-in user (owner / farmhand / buyer) unless a test says "anonymous".
"""
import os, io, datetime, importlib, pytest
from werkzeug.security import check_password_hash

ACCOUNTS = {'owner': ('owner@farm.ph', 'owner'), 'hand': ('hand@farm.ph', 'farmhand'), 'buyer': ('buyer@farm.ph', 'buyer')}
PASSWORD = 'farmtrack123'

@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('HT_DB', 'sqlite:///' + str(tmp_path / 'test.db'))
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if 'server' in sys.modules: del sys.modules['server']
    server = importlib.import_module('server')
    with server.app.app_context():
        server.db.create_all(); server.seed_database()
    assert 'test.db' in server.app.config['SQLALCHEMY_DATABASE_URI'], 'server.py must read HT_DB (see the docstring); refusing to run against the real database'
    server.app.config['TESTING'] = True
    yield server

def login(env, who, password=PASSWORD):
    email, role = ACCOUNTS[who]
    c = env.app.test_client()
    r = c.post('/api/login', json={'email': email, 'password': password, 'role': role})
    return c, r

def as_user(env, who):
    """Test client logged in as owner / hand / buyer."""
    c, r = login(env, who)
    assert r.status_code == 200, r.get_json()
    c.environ_base['HTTP_AUTHORIZATION'] = 'Bearer ' + r.get_json()['token']
    return c

def act(c, action, payload):
    return c.post('/api/action', json={'action': action, 'payload': payload})
def state(c): return c.get('/api/state').get_json()
def today(n=0): return (datetime.datetime.now()+datetime.timedelta(days=n)).strftime('%Y-%m-%d')
def order(oid, qty=2, **kw):
    d = dict(id=oid, productId='pd-1', qty=qty, deliveryType='Pickup', address='')
    d.update(kw); return d

# ---------------- functional ----------------
def test_TC01_register_buyer(env):
    c = env.app.test_client()                       # anonymous visitor registering
    r = c.post('/api/register', json=dict(name='Juan', email='juan@x.ph', phone='09171112222', password='secret123', role='owner'))
    d = r.get_json()
    assert r.status_code == 200 and d['token'] and d['user']['role'] == 'buyer'     # role in the request is ignored
    assert login(env, 'buyer')[1].status_code == 200
    c2 = env.app.test_client()
    assert c2.post('/api/login', json={'email': 'juan@x.ph', 'password': 'secret123'}).status_code == 200

def test_TC01b_owner_adds_farmhand(env):
    o = as_user(env, 'owner')
    r = act(o, 'addUser', dict(id='u-new', name='Ana', role='farmhand', email='ana@farm.ph', phone='09175556666', password='longpass123'))
    assert r.status_code == 200 and any(u['id'] == 'u-new' for u in state(o)['users'])
    bad = act(o, 'addUser', dict(id='u-bad', name='Bad', role='farmhand', email='bad@farm.ph', phone='09175556667', password='short'))
    assert bad.status_code == 400

def test_TC02_duplicate_email_rejected(env):
    o = as_user(env, 'owner')
    r = act(o, 'addUser', dict(id='u-dup', name='Dup', role='buyer', email='owner@farm.ph', phone='09170000000', password='x12345678'))
    assert r.status_code == 409 and 'already registered' in r.get_json()['error']
    r2 = env.app.test_client().post('/api/register', json=dict(name='D', email='OWNER@farm.ph', phone='09170000000', password='x12345678'))
    assert r2.status_code == 409

def test_TC03_duplicate_livestock_tag(env):
    o = as_user(env, 'owner')
    r = act(o, 'addLivestock', dict(id='lv-x', tag='CHK-101', type='Chicken', breed='Native', gender='Female', birth=today(-5), health='Healthy', registered=today()))
    assert r.status_code == 409 and 'already exists' in r.get_json()['error']

def test_TC04_overdue_flag_and_notification(env):
    o, h = as_user(env, 'owner'), as_user(env, 'hand')
    act(o, 'addTask', dict(id='tk-od', type='Feeding', targetType='livestock', target='lv-c1', targetLabel='Chicken CHK-101', date=today(-2), assignedTo='u-hand1', priority='Normal', status='Due', remarks=''))
    s = state(h)
    t = [x for x in s['tasks'] if x['id'] == 'tk-od'][0]
    n = [x for x in s['notifications'] if x['type'] == 'Overdue Task']
    assert t['status'] == 'Overdue' and n

def test_TC05_complete_task_and_harvest(env):
    o, h = as_user(env, 'owner'), as_user(env, 'hand')
    act(o, 'addTask', dict(id='tk-h', type='Harvesting', targetType='crop', target='cp-1', targetLabel='Rambutan Plot CR-001', date=today(), assignedTo='u-hand1', priority='Normal', status='Due', remarks=''))
    r = act(h, 'completeTask', dict(id='tk-h', isHarvest=True, cropType='Rambutan', qty=120.5, unit='kg', remarks='ok', userId='u-owner'))   # userId is ignored
    assert r.status_code == 200
    s = state(o)
    t = [x for x in s['tasks'] if x['id'] == 'tk-h'][0]
    plot = [x for x in s['cropPlots'] if x['id'] == 'cp-1'][0]
    assert t['status'] == 'Completed' and t['completedBy'] == 'u-hand1' and t['completedAt'] == today()
    assert plot['growthStage'] == 'Harvested' and any(y['quantity'] == 120.5 and y['recordedBy'] == 'u-hand1' for y in s['yieldRecords'])

def test_TC06a_stock_out_to_zero(env):
    o = as_user(env, 'owner')
    act(o, 'stockTx', dict(id='iv-6', amount=-4))
    assert [x for x in state(o)['inventory'] if x['id'] == 'iv-6'][0]['qty'] == 0

def test_TC06b_stock_out_cannot_go_negative(env):
    o = as_user(env, 'owner')
    r = act(o, 'stockTx', dict(id='iv-6', amount=-10))
    q = [x for x in state(o)['inventory'] if x['id'] == 'iv-6'][0]['qty']
    assert r.status_code == 400 and q == 4

def test_TC06c_low_stock_alert(env):
    o = as_user(env, 'owner')
    # iv-6: 4 boxes, reorder level 3. Taking 2 leaves 2 -> alert once
    act(o, 'stockTx', dict(id='iv-6', amount=-2))
    low = [n for n in state(o)['notifications'] if n['type'] == 'Low Stock']
    assert len(low) == 1 and 'Deworming' in low[0]['text']
    act(o, 'stockTx', dict(id='iv-6', amount=-1))                 # already low: no second alert
    assert len([n for n in state(o)['notifications'] if n['type'] == 'Low Stock']) == 1
    act(o, 'stockTx', dict(id='iv-6', amount=10))                 # restock, then drop again -> new alert
    act(o, 'stockTx', dict(id='iv-6', amount=-9))
    assert len([n for n in state(o)['notifications'] if n['type'] == 'Low Stock']) == 2
    assert not [n for n in state(as_user(env, 'hand'))['notifications'] if n['type'] == 'Low Stock']   # owner only

def test_TC07_order_exceeding_stock_rejected(env):
    b, o = as_user(env, 'buyer'), as_user(env, 'owner')
    avail = [p for p in state(b)['products'] if p['id'] == 'pd-1'][0]['qty']
    r = act(b, 'submitOrder', order('ord-big', qty=avail + 50))
    assert r.status_code == 400 and not [x for x in state(o)['orders'] if x['id'] == 'ord-big']
    assert act(b, 'submitOrder', order('ord-zero', qty=0)).status_code == 400
    assert act(b, 'submitOrder', order('ord-neg', qty=-3)).status_code == 400
    assert act(b, 'submitOrder', order('ord-del', deliveryType='Delivery', address='')).status_code == 400

def test_TC08_order_lifecycle(env):
    b, o = as_user(env, 'buyer'), as_user(env, 'owner')
    avail = [p for p in state(b)['products'] if p['id'] == 'pd-1'][0]['qty']
    act(b, 'submitOrder', order('ord-ok', qty=2, deliveryType='Delivery', address='Brgy. X', total=1))     # client total is ignored
    s = state(o)
    assert [x for x in s['orders'] if x['id'] == 'ord-ok'][0]['total'] == 440
    assert any(n['type'] == 'New Order' for n in s['notifications'])
    act(o, 'updateOrderStatus', dict(id='ord-ok', status='Confirmed'))
    s = state(b); assert [x for x in s['orders'] if x['id'] == 'ord-ok'][0]['status'] == 'Confirmed'
    assert any(n['type'] == 'Order Update' for n in s['notifications'])
    act(o, 'updateOrderStatus', dict(id='ord-ok', status='Completed'))
    assert [p for p in state(b)['products'] if p['id'] == 'pd-1'][0]['qty'] == avail - 2
    # a finished order cannot be changed again (stops double stock deduction)
    assert act(o, 'updateOrderStatus', dict(id='ord-ok', status='Completed')).status_code == 409
    assert [p for p in state(b)['products'] if p['id'] == 'pd-1'][0]['qty'] == avail - 2

def test_TC08b_buyer_cancel_pending_only(env):
    b, o = as_user(env, 'buyer'), as_user(env, 'owner')
    act(b, 'submitOrder', order('o-p', qty=1)); act(b, 'submitOrder', order('o-c', qty=1))
    act(o, 'updateOrderStatus', dict(id='o-c', status='Confirmed'))
    assert act(b, 'cancelOrder', dict(id='o-p')).status_code == 200
    assert act(b, 'cancelOrder', dict(id='o-c')).status_code == 409
    st = {x['id']: x['status'] for x in state(b)['orders']}
    assert st['o-p'] == 'Cancelled' and st['o-c'] == 'Confirmed'

def test_TC09_report_source_data(env):
    o = as_user(env, 'owner')
    act(o, 'addExpense', dict(id='ex-1', category='Feed', description='Layer mash', amount=1500.0, date=today(), recordedBy='u-hand1'))
    s = state(o)
    assert any(e['amount'] == 1500.0 and e['recordedBy'] == 'u-owner' for e in s['expenses'])
    assert 'yieldRecords' in s and 'orders' in s
    assert act(o, 'addExpense', dict(id='ex-0', category='Feed', description='x', amount=-5, date=today())).status_code == 400

def test_TC10_cross_device_sync(env):
    a, b = as_user(env, 'owner'), as_user(env, 'owner')
    act(a, 'addLivestock', dict(id='lv-new', tag='GOT-999', type='Goat', breed='Alpine', gender='Female', birth=today(-100), health='Healthy', registered=today()))
    assert any(x['id'] == 'lv-new' for x in state(b)['livestock'])

def test_TC11_bad_requests_do_not_crash(env):
    o = as_user(env, 'owner')
    assert o.post('/api/action', data='not json', content_type='application/json').status_code == 400
    assert act(o, 'addLivestock', dict(bogus='x')).status_code == 400
    assert act(o, 'doesNotExist', {}).status_code == 400

# ---------------- security ----------------
def test_SEC1_passwords_not_exposed(env):
    for who in ('owner', 'hand', 'buyer'):
        raw = as_user(env, who).get('/api/state').get_data(as_text=True)
        assert 'password' not in raw and 'scrypt' not in raw and 'pbkdf2' not in raw

def test_SEC2_passwords_hashed_at_rest(env):
    with env.app.app_context():
        pw = env.User.query.filter_by(id='u-owner').first().password
    assert pw != PASSWORD and len(pw) >= 40 and check_password_hash(pw, PASSWORD)

def test_SEC3_anonymous_calls_rejected(env):
    anon = env.app.test_client()
    r = act(anon, 'deleteUser', dict(id='u-hand1'))
    assert r.status_code == 401
    assert anon.get('/api/state').status_code == 401
    assert any(u['id'] == 'u-hand1' for u in state(as_user(env, 'owner'))['users'])

def test_SEC3b_role_checks(env):
    h, b, o = as_user(env, 'hand'), as_user(env, 'buyer'), as_user(env, 'owner')
    assert act(h, 'deleteUser', dict(id='u-buyer1')).status_code == 403
    assert act(h, 'addExpense', dict(id='x1', category='Feed', description='x', amount=5, date=today())).status_code == 403
    assert act(b, 'stockTx', dict(id='iv-1', amount=100)).status_code == 403
    assert act(b, 'addUser', dict(id='u-x', name='X', role='owner', email='x@x.ph', phone='09170000001', password='longpass123')).status_code == 403
    assert act(b, 'updateOrderStatus', dict(id='nope', status='Completed')).status_code == 403
    assert act(o, 'submitOrder', order('o-by-owner')).status_code == 403           # only buyers place orders
    assert any(u['id'] == 'u-buyer1' for u in state(o)['users'])

def test_SEC3c_identity_cannot_be_spoofed(env):
    b, o, h = as_user(env, 'buyer'), as_user(env, 'owner'), as_user(env, 'hand')
    act(b, 'submitOrder', order('o-spoof', qty=1, buyerId='u-owner', status='Completed', paymentStatus='Paid'))
    od = [x for x in state(o)['orders'] if x['id'] == 'o-spoof'][0]
    assert od['buyerId'] == 'u-buyer1' and od['status'] == 'Pending' and od['paymentStatus'] == 'Pending'
    act(o, 'addTask', dict(id='tk-own', type='Maintenance', targetType='other', target='', targetLabel='Barn', date=today(), assignedTo='u-owner', priority='Normal', status='Due', remarks=''))
    assert act(h, 'completeTask', dict(id='tk-own')).status_code == 403            # not assigned to this farmhand
    assert act(b, 'cancelOrder', dict(id='o-spoof')).status_code == 200
    assert act(h, 'updateProfile', dict(id='u-owner', name='Hacked', phone='09170000000')).status_code == 403
    assert act(o, 'deleteUser', dict(id='u-owner')).status_code == 400             # cannot delete yourself

def test_SEC3d_state_is_limited_by_role(env):
    b, h = state(as_user(env, 'buyer')), state(as_user(env, 'hand'))
    assert [u['id'] for u in b['users']] == ['u-buyer1'] and not b['expenses'] and not b['inventory'] and not b['tasks'] and b['products']
    assert [u['id'] for u in h['users']] == ['u-hand1'] and not h['expenses'] and not h['orders'] and h['livestock']
    assert all(t['assignedTo'] == 'u-hand1' for t in h['tasks'])

def test_SEC4_sql_injection_is_parameterized(env):
    o = as_user(env, 'owner')
    evil = "x'); DROP TABLE user;--"
    act(o, 'addExpense', dict(id='ex-evil', category=evil, description=evil, amount=1.0, date=today()))
    s = state(o)
    assert any(e['category'] == evil for e in s['expenses']) and len(s['users']) == 3
    r = env.app.test_client().post('/api/login', json={'email': "' OR '1'='1", 'password': "' OR '1'='1"})
    assert r.status_code == 401

def test_SEC5_transport_is_https(env):
    pytest.skip('server.py serves plain HTTP; HTTPS must be provided by the hosting layer and verified on the deployed URL')

def test_SEC6_login_rules(env):
    assert login(env, 'owner', 'wrong-password')[1].status_code == 401
    c = env.app.test_client()
    assert c.post('/api/login', json={'email': 'nobody@farm.ph', 'password': PASSWORD}).status_code == 401
    assert c.post('/api/login', json={'email': 'owner@farm.ph', 'password': PASSWORD, 'role': 'buyer'}).status_code == 403
    o = as_user(env, 'owner')
    old = as_user(env, 'hand')
    act(o, 'toggleUserStatus', dict(id='u-hand1'))                                  # deactivate
    assert login(env, 'hand')[1].status_code == 403
    assert old.get('/api/state').status_code == 401                                 # existing token stops working

def test_SEC7_bad_and_expired_tokens(env, monkeypatch):
    c = env.app.test_client()
    c.environ_base['HTTP_AUTHORIZATION'] = 'Bearer not.a.real.token'
    assert c.get('/api/state').status_code == 401
    o = as_user(env, 'owner')
    monkeypatch.setattr(env, 'TOKEN_MAX_AGE', -1)                                   # every token is now "expired"
    assert o.get('/api/state').status_code == 401

def test_SEC8_source_and_database_not_downloadable(env):
    c = env.app.test_client()
    for path in ('/server.py', '/instance/harvtrack.db', '/harvtrack.db', '/test_harvtrack_api.py', '/docker-compose.yml', '/.github/workflows/deploy.yml', '/README.md'):
        assert c.get(path).status_code == 404, path
    assert c.get('/index.html').status_code == 200

def test_SEC9_upload_is_restricted(env):
    png = (io.BytesIO(b'\x89PNG\r\n\x1a\nfake'), 'pic.png')
    assert env.app.test_client().post('/api/upload', data={'file': png}, content_type='multipart/form-data').status_code == 401
    assert as_user(env, 'buyer').post('/api/upload', data={'file': (io.BytesIO(b'x'), 'pic.png')}, content_type='multipart/form-data').status_code == 403
    o = as_user(env, 'owner')
    assert o.post('/api/upload', data={'file': (io.BytesIO(b'<?py?>'), 'evil.py')}, content_type='multipart/form-data').status_code == 400
    r = o.post('/api/upload', data={'file': (io.BytesIO(b'\x89PNG\r\n\x1a\nfake'), 'pic.png')}, content_type='multipart/form-data')
    assert r.status_code == 200 and r.get_json()['path'].startswith('img/prod_')

def test_SEC10_login_attempts_are_throttled(env):
    c = env.app.test_client()
    codes = [c.post('/api/login', json={'email': 'owner@farm.ph', 'password': 'bad%d' % i}).status_code for i in range(10)]
    assert codes[:8] == [401] * 8 and codes[8] == 429
    assert c.post('/api/login', json={'email': 'owner@farm.ph', 'password': PASSWORD}).status_code == 429

def test_SEC11_existing_plaintext_passwords_are_migrated(env):
    with env.app.app_context():
        env.User.query.filter_by(id='u-owner').first().password = 'oldplain123'
        env.db.session.commit()
        env.migrate_database()
        pw = env.User.query.filter_by(id='u-owner').first().password
    assert pw != 'oldplain123' and check_password_hash(pw, 'oldplain123')
