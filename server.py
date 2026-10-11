"""
HarvTrack - Flask REST API & Backend Server
Run with: python server.py

Security model
  * POST /api/login and /api/register return a signed, expiring token.
  * Every other API call must send it as  Authorization: Bearer <token>.
  * Passwords are stored hashed (werkzeug). GET /api/state never returns them.
  * Each action in /api/action is allowed only for specific roles (see PERMISSIONS)
    and the server fills in identity fields (buyerId, recordedBy, userId) itself.
Environment variables
  HT_DB      database URI           (default sqlite:///harvtrack.db)
  HT_SECRET  secret used to sign tokens - SET THIS IN PRODUCTION
  HT_HOST    bind address for `python server.py` (default 127.0.0.1; containers use gunicorn via wsgi.py)
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from itsdangerous import URLSafeTimedSerializer, BadSignature
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
import os, re, time, datetime, uuid, random

# static_folder=None: files are served only by the allow-list route below
app = Flask(__name__, static_folder=None)
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('HT_DB', 'sqlite:///harvtrack.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024        # 5 MB max request (image uploads)
app.config['SECRET_KEY'] = os.environ.get('HT_SECRET', 'dev-only-change-me')
db = SQLAlchemy(app)

TOKEN_MAX_AGE = 12 * 60 * 60                               # login lasts 12 hours
_serializer = URLSafeTimedSerializer(app.config['SECRET_KEY'], salt='harvtrack-auth')

# Ensure img directory exists for uploads
os.makedirs('img', exist_ok=True)

GLOBAL_SETTINGS = {
    "farmName":"Titular Farm",
    "location":"Barangay San Nicolas, San Pablo City, Laguna",
    "theme":"system",
    "livestockTypes": ["Chicken", "Goat", "Pig", "Cow"],
    "cropTypes": ["Rambutan", "Lanzones", "Mango", "Avocado", "Dragon Fruit", "Buko Trees"]
}

# ----------------- DB MODELS -----------------
class User(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    name = db.Column(db.String(100))
    role = db.Column(db.String(20))
    email = db.Column(db.String(100), unique=True)
    phone = db.Column(db.String(20))
    password = db.Column(db.String(255))          # werkzeug hash, never plain text
    status = db.Column(db.String(20), default="Active")

class Livestock(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    tag = db.Column(db.String(50), unique=True)
    type = db.Column(db.String(50))
    breed = db.Column(db.String(50))
    gender = db.Column(db.String(20))
    birth = db.Column(db.String(20))
    health = db.Column(db.String(50))
    registered = db.Column(db.String(20))

class CropPlot(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    plotId = db.Column(db.String(50), unique=True)
    cropType = db.Column(db.String(50))
    location = db.Column(db.String(100))
    area = db.Column(db.String(50))
    plantingDate = db.Column(db.String(20))
    growthStage = db.Column(db.String(50))
    lastUpdated = db.Column(db.String(20))

class Task(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    type = db.Column(db.String(50))
    targetType = db.Column(db.String(20))
    target = db.Column(db.String(50))
    targetLabel = db.Column(db.String(100))
    date = db.Column(db.String(20))
    assignedTo = db.Column(db.String(50))
    priority = db.Column(db.String(20))
    status = db.Column(db.String(20))
    remarks = db.Column(db.String(200))
    completedAt = db.Column(db.String(20), nullable=True)
    completedBy = db.Column(db.String(50), nullable=True)

class YieldRecord(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    plotId = db.Column(db.String(50))
    cropType = db.Column(db.String(50))
    harvestDate = db.Column(db.String(20))
    quantity = db.Column(db.Float)
    unit = db.Column(db.String(20))
    recordedBy = db.Column(db.String(50))

class Expense(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    category = db.Column(db.String(50))
    description = db.Column(db.String(200))
    amount = db.Column(db.Float)
    date = db.Column(db.String(20))
    recordedBy = db.Column(db.String(50))

class Inventory(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    name = db.Column(db.String(100))
    category = db.Column(db.String(50))
    unit = db.Column(db.String(20))
    qty = db.Column(db.Float)
    reorderLevel = db.Column(db.Float, default=5)   # low-stock alert when qty <= reorderLevel
    dateAdded = db.Column(db.String(20))

class Product(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    name = db.Column(db.String(100))
    category = db.Column(db.String(50))
    unit = db.Column(db.String(20))
    price = db.Column(db.Float)
    qty = db.Column(db.Float)
    image = db.Column(db.String(255), nullable=True)

class Order(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    buyerId = db.Column(db.String(50))
    productId = db.Column(db.String(50))
    productName = db.Column(db.String(100))
    unit = db.Column(db.String(20))
    qty = db.Column(db.Float)
    total = db.Column(db.Float)
    status = db.Column(db.String(20))
    paymentStatus = db.Column(db.String(20), default="Pending")
    deliveryType = db.Column(db.String(20), default="Pickup")
    address = db.Column(db.String(200), nullable=True)
    time = db.Column(db.String(20))

class Notification(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    type = db.Column(db.String(50))
    text = db.Column(db.String(200))
    time = db.Column(db.String(20))
    read = db.Column(db.Boolean, default=False)
    userId = db.Column(db.String(50))

def to_dict(model_instance):
    return {c.name: getattr(model_instance, c.name) for c in model_instance.__table__.columns}

def user_public(u):
    """User record without the password hash."""
    d = to_dict(u); d.pop('password', None); return d

# ----------------- HELPERS -----------------
def fail(msg, code=400):
    db.session.rollback()
    return jsonify({"success": False, "error": msg}), code

@app.errorhandler(IntegrityError)
def on_integrity_error(e):
    # e.g. duplicate email / livestock tag / plot ID / id that slipped past the pre-checks
    return fail("Duplicate or invalid record: a value that must be unique already exists.", 409)

@app.errorhandler(KeyError)
@app.errorhandler(TypeError)
@app.errorhandler(AttributeError)
def on_bad_payload(e):
    return fail("Invalid request: missing or unexpected fields.", 400)

@app.errorhandler(413)
def on_too_large(e):
    return fail("File or request is too large (5 MB maximum).", 413)

def by_id(model, key):
    return db.session.get(model, key) if key else None

PHONE_RE = re.compile(r'^09\d{9}$')
EMAIL_RE = re.compile(r'^\S+@\S+\.\S+$')
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
def clean_phone(v): return re.sub(r'\D', '', str(v or ''))
def new_id(prefix): return f"{prefix}-{uuid.uuid4().hex[:8]}"
def number(v):
    try: return float(v)
    except (TypeError, ValueError): return None

def is_hashed(p): return bool(p) and str(p).startswith(('scrypt:', 'pbkdf2:'))
def hash_pw(p): return generate_password_hash(p)

def notify(user_id, type_, text_, today):
    db.session.add(Notification(id=new_id("nt"), type=type_, text=text_, time=today, userId=user_id))

def notify_owners(type_, text_, today):
    for o in User.query.filter_by(role='owner', status='Active').all():
        notify(o.id, type_, text_, today)

# ---- authentication ----
def make_token(user):
    return _serializer.dumps({'uid': user.id})

def current_user():
    h = request.headers.get('Authorization', '')
    if not h.startswith('Bearer '): return None
    try:
        data = _serializer.loads(h[7:], max_age=TOKEN_MAX_AGE)
    except BadSignature:                      # also covers expired tokens
        return None
    u = by_id(User, data.get('uid'))
    return u if u and u.status == 'Active' else None

_failed_logins = {}                           # simple brute-force throttle (per process)
FAIL_LIMIT, FAIL_WINDOW = 8, 300
def _recent_failures(key):
    now = time.time()
    _failed_logins[key] = [t for t in _failed_logins.get(key, []) if now - t < FAIL_WINDOW]
    return _failed_logins[key]

# ----------------- ROUTING (static files: allow-list only) -----------------
PUBLIC_FILES = {'index.html', 'sw.js', 'manifest.json'}
PUBLIC_DIRS = {'css', 'js', 'img'}

@app.route('/')
def index(): return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    # Never expose server.py, the database file, tests, .git, etc.
    if path in PUBLIC_FILES or (path.split('/', 1)[0] in PUBLIC_DIRS and '/' in path):
        resp = send_from_directory('.', path)
        if path in ('sw.js', 'manifest.json'):
            resp.headers['Cache-Control'] = 'no-cache'
        return resp
    return "Not found", 404

# ----------------- AUTH ROUTES -----------------
@app.route('/api/login', methods=['POST'])
def login():
    d = request.get_json(silent=True) or {}
    email = str(d.get('email', '')).strip().lower()
    password = str(d.get('password', ''))
    role = d.get('role')
    key = f"{email}|{request.remote_addr}"
    if len(_recent_failures(key)) >= FAIL_LIMIT:
        return fail("Too many failed attempts. Try again in a few minutes.", 429)
    u = User.query.filter(db.func.lower(User.email) == email).first()
    if not u or not is_hashed(u.password) or not check_password_hash(u.password, password):
        _failed_logins[key].append(time.time())
        return fail("Incorrect email or password.", 401)
    if role and u.role != role:
        return fail(f"This email is registered as {u.role}. Select the matching tab.", 403)
    if u.status != 'Active':
        return fail("This account has been deactivated. Contact the farm owner.", 403)
    _failed_logins.pop(key, None)
    return jsonify({"success": True, "token": make_token(u), "user": user_public(u)})

@app.route('/api/register', methods=['POST'])
def register():
    """Public self-registration. Always creates a BUYER account."""
    d = request.get_json(silent=True) or {}
    name = str(d.get('name', '')).strip()
    email = str(d.get('email', '')).strip()
    phone = clean_phone(d.get('phone'))
    password = str(d.get('password', ''))
    if not name or not email or not phone or not password: return fail("All fields required.")
    if not EMAIL_RE.match(email): return fail("Invalid email.")
    if not PHONE_RE.match(phone): return fail("Use a valid 11-digit number starting with 09.")
    if len(password) < 8: return fail("Password must be at least 8 characters.")
    if User.query.filter(db.func.lower(User.email) == email.lower()).first():
        return fail(f"Email '{email}' is already registered.", 409)
    u = User(id=new_id("u"), name=name, role="buyer", email=email, phone=phone, password=hash_pw(password), status="Active")
    db.session.add(u); db.session.commit()
    return jsonify({"success": True, "token": make_token(u), "user": user_public(u)})

# ----------------- API ROUTES -----------------
@app.route('/api/upload', methods=['POST'])
def upload_image():
    user = current_user()
    if not user: return fail("Please log in again.", 401)
    if user.role != 'owner': return fail("Only the owner can upload product images.", 403)
    if 'file' not in request.files:
        return fail("No file uploaded")
    file = request.files['file']
    if file.filename == '':
        return fail("No file selected")
    ext = file.filename.rsplit('.', 1)[1].lower() if '.' in file.filename else ''
    if ext not in {'jpg', 'jpeg', 'png', 'gif', 'webp'}:
        return fail("Only JPG, PNG, GIF or WEBP images are allowed.")
    filename = f"prod_{uuid.uuid4().hex[:8]}.{ext}"
    filepath = os.path.join('img', filename)
    file.save(filepath)
    return jsonify({"success": True, "path": filepath.replace('\\', '/')})

@app.route('/api/state', methods=['GET'])
def get_state():
    user = current_user()
    if not user: return fail("Please log in again.", 401)
    role = user.role
    today = datetime.datetime.now().strftime('%Y-%m-%d')

    overdue_tasks = Task.query.filter(Task.status.in_(['Due', 'Rescheduled']), Task.date < today).all()
    if overdue_tasks:
        for t in overdue_tasks:
            t.status = 'Overdue'
            notify(t.assignedTo, "Overdue Task", f"Task '{t.type}' is overdue.", today)
        db.session.commit()

    livestock_data = [to_dict(l) for l in Livestock.query.all()] if role in ('owner', 'farmhand') else []
    crop_data = [to_dict(c) for c in CropPlot.query.all()] if role in ('owner', 'farmhand') else []
    l_totals = {}
    for l in livestock_data: l_totals[l['type']] = l_totals.get(l['type'], 0) + 1

    all_tasks = Task.query.order_by(Task.date.desc())
    my_notifs = Notification.query.filter_by(userId=user.id).order_by(Notification.time.desc())
    state = {
        "users": [user_public(u) for u in User.query.all()] if role == 'owner' else [user_public(user)],
        "livestock": livestock_data,
        "cropPlots": crop_data,
        "tasks": [to_dict(t) for t in all_tasks.all()] if role == 'owner' else
                 [to_dict(t) for t in all_tasks.filter_by(assignedTo=user.id).all()] if role == 'farmhand' else [],
        "yieldRecords": [to_dict(y) for y in YieldRecord.query.all()] if role == 'owner' else [],
        "expenses": [to_dict(e) for e in Expense.query.order_by(Expense.date.desc()).all()] if role == 'owner' else [],
        "inventory": [to_dict(i) for i in Inventory.query.all()] if role == 'owner' else [],
        "products": [to_dict(p) for p in Product.query.all()] if role in ('owner', 'buyer') else [],
        "orders": [to_dict(o) for o in Order.query.order_by(Order.time.desc()).all()] if role == 'owner' else
                  [to_dict(o) for o in Order.query.filter_by(buyerId=user.id).order_by(Order.time.desc()).all()] if role == 'buyer' else [],
        "notifications": [to_dict(n) for n in my_notifs.all()],
        "settings": GLOBAL_SETTINGS,
        "livestockTotals": l_totals
    }
    return jsonify(state)

# role -> allowed actions
OWNER, STAFF, BUYER, ANY = {'owner'}, {'owner', 'farmhand'}, {'buyer'}, {'owner', 'farmhand', 'buyer'}
PERMISSIONS = {
    'addLivestock': OWNER, 'removeLivestock': OWNER, 'updateLivestockHealth': STAFF,
    'addCrop': OWNER, 'deleteCrop': OWNER, 'updateCropStage': OWNER,
    'addTask': OWNER, 'completeTask': STAFF, 'rescheduleTask': STAFF,
    'addInventory': OWNER, 'stockTx': OWNER, 'addExpense': OWNER,
    'addProduct': OWNER, 'updateProduct': OWNER, 'deleteProduct': OWNER,
    'submitOrder': BUYER, 'cancelOrder': BUYER, 'updateOrderStatus': OWNER,
    'addUser': OWNER, 'toggleUserStatus': OWNER, 'deleteUser': OWNER,
    'updateProfile': ANY, 'updateSettings': OWNER, 'markAllRead': ANY,
}
ORDER_FLOW = {'Pending': {'Confirmed', 'Rejected'}, 'Confirmed': {'Completed'}}

@app.route('/api/action', methods=['POST'])
def handle_action():
    user = current_user()
    if not user: return fail("Please log in again.", 401)

    data = request.get_json(silent=True) or {}
    action = data.get('action')
    payload = data.get('payload') or {}
    if not isinstance(payload, dict): return fail("Invalid payload.")
    if action not in PERMISSIONS: return fail("Unknown action.")
    if user.role not in PERMISSIONS[action]:
        return fail("You do not have permission to do that.", 403)
    today = datetime.datetime.now().strftime('%Y-%m-%d')

    if action == 'addLivestock':
        if Livestock.query.filter_by(tag=payload.get('tag')).first():
            return fail(f"Livestock tag '{payload.get('tag')}' already exists.", 409)
        db.session.add(Livestock(**payload))
    elif action == 'removeLivestock':
        Livestock.query.filter_by(id=payload['id']).delete()
    elif action == 'updateLivestockHealth':
        if payload.get('health') not in ('Healthy', 'Needs Attention'): return fail("Invalid health status.")
        l = by_id(Livestock, payload['id'])
        if l:
            l.health = payload['health']
            db.session.add(Task(id=new_id("tk"), type="Health Check", targetType="livestock", target=l.id, targetLabel=f"{l.type} {l.tag}", date=today, assignedTo=user.id, priority="Normal", status="Completed", completedAt=today, completedBy=user.id, remarks=payload.get('remarks', '')))
    elif action == 'addCrop':
        if CropPlot.query.filter_by(plotId=payload.get('plotId')).first():
            return fail(f"Plot ID '{payload.get('plotId')}' already exists.", 409)
        db.session.add(CropPlot(**payload))
    elif action == 'deleteCrop':
        CropPlot.query.filter_by(id=payload['id']).delete()
    elif action == 'updateCropStage':
        c = by_id(CropPlot, payload['id'])
        if c:
            c.growthStage = payload['stage']
            c.lastUpdated = today
    elif action == 'addTask':
        if not by_id(User, payload.get('assignedTo')): return fail("Assigned user not found.", 404)
        if not DATE_RE.match(str(payload.get('date', ''))): return fail("Invalid task date.")
        t = Task(**payload)
        db.session.add(t)
        notify(t.assignedTo, "Task Reminder", f"{t.type} for {t.targetLabel} scheduled on {t.date}.", today)
    elif action == 'completeTask':
        t = by_id(Task, payload['id'])
        if t:
            if user.role == 'farmhand' and t.assignedTo != user.id:
                return fail("You can only complete tasks assigned to you.", 403)
            t.status = "Completed"
            t.remarks = payload.get('remarks', '')
            t.completedAt = today
            t.completedBy = user.id
            if payload.get('isHarvest'):
                qty = number(payload.get('qty'))
                if qty is None or qty <= 0: return fail("Enter a valid harvest quantity.")
                db.session.add(YieldRecord(id=new_id("yr"), plotId=t.target, cropType=payload['cropType'], harvestDate=today, quantity=qty, unit=payload['unit'], recordedBy=user.id))
                c = by_id(CropPlot, t.target)
                if c:
                    c.growthStage = "Harvested"
                    c.lastUpdated = today
            if t.targetType == 'livestock':
                l = by_id(Livestock, t.target)
                if l and l.health == 'Needs Attention':
                    l.health = 'Healthy'
    elif action == 'rescheduleTask':
        t = by_id(Task, payload['id'])
        if t:
            if user.role == 'farmhand' and t.assignedTo != user.id:
                return fail("You can only reschedule tasks assigned to you.", 403)
            if not DATE_RE.match(str(payload.get('date', ''))): return fail("Invalid date.")
            t.date = payload['date']
            t.status = "Rescheduled"
            t.remarks = f"Reschedule requested: {payload['reason']}"
    elif action == 'addInventory':
        qty = number(payload.get('qty'))
        if qty is None or qty < 0: return fail("Quantity cannot be negative.")
        level = number(payload.get('reorderLevel', 5))
        if level is None or level < 0: return fail("Reorder level cannot be negative.")
        payload['reorderLevel'] = level
        db.session.add(Inventory(**payload))
        if qty <= level:
            notify_owners("Low Stock", f"{payload.get('name')} is low: {qty:g} {payload.get('unit', '')} left (reorder at {level:g}).", today)
    elif action == 'stockTx':
        i = by_id(Inventory, payload['id'])
        if i:
            amount = number(payload.get('amount'))
            if amount is None or amount == 0: return fail("Enter a valid quantity.")
            before, level = i.qty, (i.reorderLevel if i.reorderLevel is not None else 0)
            if before + amount < 0:
                return fail(f"Not enough stock: only {before:g} {i.unit} on hand.")
            i.qty = before + amount
            if amount < 0 and before > level and i.qty <= level:      # crossed the reorder level
                notify_owners("Low Stock", f"{i.name} is low: {i.qty:g} {i.unit} left (reorder at {level:g}).", today)
    elif action == 'addExpense':
        amount = number(payload.get('amount'))
        if amount is None or amount <= 0: return fail("Expense amount must be greater than zero.")
        payload['recordedBy'] = user.id
        db.session.add(Expense(**payload))
    elif action == 'addProduct':
        price, qty = number(payload.get('price')), number(payload.get('qty'))
        if price is None or price < 0 or qty is None or qty < 0: return fail("Price and quantity must not be negative.")
        db.session.add(Product(**payload))
    elif action == 'updateProduct':
        p = by_id(Product, payload['id'])
        if p:
            price, qty = number(payload['price']), number(payload['qty'])
            if price is None or price < 0 or qty is None or qty < 0: return fail("Price and quantity must not be negative.")
            p.name = payload['name']
            p.category = payload['category']
            p.price = price
            p.qty = qty
            p.unit = payload['unit']
            p.image = payload.get('image', '')
    elif action == 'deleteProduct':
        Product.query.filter_by(id=payload['id']).delete()
    elif action == 'submitOrder':
        p = by_id(Product, payload.get('productId'))
        if not p: return fail("Product not found.", 404)
        qty = number(payload.get('qty'))
        if qty is None or qty <= 0: return fail("Order quantity must be greater than zero.")
        if qty > p.qty: return fail(f"Only {p.qty:g} {p.unit} of {p.name} available.")
        method = payload.get('deliveryType', 'Pickup')
        if method not in ('Pickup', 'Delivery'): return fail("Invalid fulfillment method.")
        address = str(payload.get('address') or '').strip()
        if method == 'Delivery' and not address: return fail("Delivery address is required.")
        # the server decides price, owner of the order, status and date
        o = Order(id=payload.get('id') or new_id("ord"), buyerId=user.id, productId=p.id, productName=p.name, unit=p.unit,
                  qty=qty, total=round(p.price * qty, 2), status="Pending", paymentStatus="Pending",
                  deliveryType=method, address=address, time=today)
        db.session.add(o)
        notify_owners("New Order", f"New order for {o.qty:g} {o.unit} of {o.productName}.", today)
    elif action == 'cancelOrder':
        o = by_id(Order, payload['id'])
        if o:
            if o.buyerId != user.id: return fail("You can only cancel your own orders.", 403)
            if o.status != 'Pending': return fail("Only pending orders can be cancelled.", 409)
            o.status = 'Cancelled'
            notify_owners("Order Update", f"Order #{o.id[-5:]} was cancelled by buyer.", today)
    elif action == 'updateOrderStatus':
        o = by_id(Order, payload['id'])
        if o:
            new = payload['status']
            if new not in ORDER_FLOW.get(o.status, set()):
                return fail(f"An order that is {o.status} cannot be changed to {new}.", 409)
            o.status = new
            notify(o.buyerId, "Order Update", f"Your order #{o.id[-5:]} was {new}.", today)
            if new == 'Completed':
                p = by_id(Product, o.productId)
                if p: p.qty = max(0, p.qty - o.qty)
    elif action == 'addUser':
        name, email = str(payload.get('name', '')).strip(), str(payload.get('email', '')).strip()
        phone, password = clean_phone(payload.get('phone')), str(payload.get('password', ''))
        role = payload.get('role')
        if not name or not email: return fail("Please fill all required fields.")
        if role not in ('owner', 'farmhand', 'buyer'): return fail("Invalid role.")
        if not EMAIL_RE.match(email): return fail("Invalid email.")
        if not PHONE_RE.match(phone): return fail("Use a valid 11-digit number starting with 09.")
        if len(password) < 8: return fail("Password must be at least 8 characters.")
        if User.query.filter(db.func.lower(User.email) == email.lower()).first():
            return fail(f"Email '{email}' is already registered.", 409)
        db.session.add(User(id=payload.get('id') or new_id("u"), name=name, role=role, email=email, phone=phone, password=hash_pw(password), status="Active"))
    elif action == 'toggleUserStatus':
        if payload['id'] == user.id: return fail("You cannot deactivate your own account.")
        u = by_id(User, payload['id'])
        if u: u.status = "Active" if u.status == "Inactive" else "Inactive"
    elif action == 'deleteUser':
        if payload['id'] == user.id: return fail("You cannot delete your own account.")
        User.query.filter_by(id=payload['id']).delete()
    elif action == 'updateProfile':
        if payload['id'] != user.id and user.role != 'owner': return fail("You can only edit your own profile.", 403)
        u = by_id(User, payload['id'])
        if u:
            name, phone = str(payload['name']).strip(), clean_phone(payload['phone'])
            if not name: return fail("Name cannot be empty.")
            if not PHONE_RE.match(phone): return fail("Use a valid 11-digit number starting with 09.")
            u.name = name
            u.phone = phone
    elif action == 'updateSettings':
        theme = payload.get('theme', 'system')
        if theme not in ('system', 'light', 'dark'): return fail("Invalid theme.")
        GLOBAL_SETTINGS['theme'] = theme
    elif action == 'markAllRead':
        for n in Notification.query.filter_by(userId=user.id, read=False).all():
            n.read = True

    db.session.commit()
    return jsonify({"success": True})

def seed_database():
    today = datetime.datetime.now()
    def dt(days): return (today + datetime.timedelta(days=days)).strftime('%Y-%m-%d')

    db.session.add_all([
        User(id="u-owner", name="Mang Ramon (Owner)", role="owner", email="owner@farm.ph", phone="09171234567", password=hash_pw("farmtrack123"), status="Active"),
        User(id="u-hand1", name="Pedro (Farmhand)", role="farmhand", email="hand@farm.ph", phone="09182345678", password=hash_pw("farmtrack123"), status="Active"),
        User(id="u-buyer1", name="Aling Nena (Buyer)", role="buyer", email="buyer@farm.ph", phone="09193456789", password=hash_pw("farmtrack123"), status="Active")
    ])

    animals = []
    for i in range(1, 11): animals.append(Livestock(id=f"lv-c{i}", tag=f"CHK-{100+i:03d}", type="Chicken", breed="Native", gender="Female", birth=dt(-200), health="Healthy", registered=dt(-10)))
    for i in range(1, 14): animals.append(Livestock(id=f"lv-w{i}", tag=f"COW-{100+i:03d}", type="Cow", breed="Brahman", gender="Female", birth=dt(-500), health="Healthy", registered=dt(-10)))
    for i in range(1, 19): animals.append(Livestock(id=f"lv-g{i}", tag=f"GOT-{100+i:03d}", type="Goat", breed="Alpine", gender="Female", birth=dt(-300), health="Needs Attention" if i==2 else "Healthy", registered=dt(-10)))
    for i in range(1, 4): animals.append(Livestock(id=f"lv-pi{i}", tag=f"PIG-I{10+i:02d}", type="Pig", breed="Inahin (Mother)", gender="Female", birth=dt(-600), health="Needs Attention" if i==1 else "Healthy", registered=dt(-10)))
    for i in range(1, 11): animals.append(Livestock(id=f"lv-pf{i}", tag=f"PIG-F{10+i:02d}", type="Pig", breed="Fattener", gender="Male", birth=dt(-150), health="Healthy", registered=dt(-10)))
    for i in range(1, 8): animals.append(Livestock(id=f"lv-ps{i}", tag=f"PIG-S{10+i:02d}", type="Pig", breed="Small Piglet", gender="Mixed", birth=dt(-30), health="Healthy", registered=dt(-5)))
    db.session.add_all(animals)

    db.session.add_all([
        CropPlot(id="cp-1", plotId="CR-001", cropType="Rambutan", location="Plot A - Near Star Apple Fruit", area="1.0 hectare", plantingDate=dt(-900), growthStage="Fruiting", lastUpdated=dt(-10)),
        CropPlot(id="cp-2", plotId="CR-002", cropType="Rambutan", location="Plot B - Ilaya", area="0.8 hectare", plantingDate=dt(-850), growthStage="Growing", lastUpdated=dt(-5)),
        CropPlot(id="cp-3", plotId="CR-003", cropType="Rambutan", location="Plot C - Near Calamansian", area="1.2 hectares", plantingDate=dt(-920), growthStage="Flowering", lastUpdated=dt(-8)),
        CropPlot(id="cp-4", plotId="CR-004", cropType="Rambutan", location="Plot D - Near Buko Trees", area="0.5 hectare", plantingDate=dt(-800), growthStage="Harvested", lastUpdated=dt(-2)),
        CropPlot(id="cp-5", plotId="CL-001", cropType="Lanzones", location="Near Mango Tree", area="0.5 hectare", plantingDate=dt(-1100), growthStage="Growing", lastUpdated=dt(-12)),
        CropPlot(id="cp-6", plotId="CM-001", cropType="Mango", location="Nearby House", area="0.3 hectare", plantingDate=dt(-1500), growthStage="Fruiting", lastUpdated=dt(-5)),
        CropPlot(id="cp-7", plotId="CB-001", cropType="Buko Trees", location="Ilaya", area="1.5 hectares", plantingDate=dt(-2000), growthStage="Fruiting", lastUpdated=dt(-20)),
        CropPlot(id="cp-8", plotId="CA-001", cropType="Avocado", location="Nearby House", area="0.2 hectare", plantingDate=dt(-1200), growthStage="Fruiting", lastUpdated=dt(-7)),
        CropPlot(id="cp-9", plotId="CD-001", cropType="Dragon Fruit", location="Plot D - Near Buko Trees", area="0.1 hectare", plantingDate=dt(-700), growthStage="Flowering", lastUpdated=dt(-4))
    ])

    db.session.add_all([
        Inventory(id="iv-1", name="Layer Mash Feed (50kg) - For Chickens", category="Feed", unit="bags", qty=15, reorderLevel=5, dateAdded=dt(-5)),
        Inventory(id="iv-2", name="Pig Starter Feed (50kg) - For Piglets", category="Feed", unit="bags", qty=8, reorderLevel=5, dateAdded=dt(-10)),
        Inventory(id="iv-3", name="Cow Dairy Ration & Hay", category="Feed", unit="bags", qty=12, reorderLevel=5, dateAdded=dt(-2)),
        Inventory(id="iv-4", name="Goat Maintenance Pellets", category="Feed", unit="bags", qty=6, reorderLevel=5, dateAdded=dt(-1)),
        Inventory(id="iv-5", name="Anti-Rabies/Parvo Vaccine", category="Veterinary", unit="vials", qty=20, reorderLevel=5, dateAdded=dt(-30)),
        Inventory(id="iv-6", name="Deworming Tablets / Paste", category="Veterinary", unit="boxes", qty=4, reorderLevel=3, dateAdded=dt(-40)),
        Inventory(id="iv-7", name="Vitamins & Electrolytes (Water Soluble)", category="Veterinary", unit="packs", qty=18, reorderLevel=5, dateAdded=dt(-5)),
    ])

    db.session.add_all([
        Product(id="pd-1", name="Fresh Chicken Eggs", category="Eggs", unit="tray", price=220, qty=18, image=""),
        Product(id="pd-4", name="Live Cow (Brahman)", category="Livestock", unit="head", price=35000, qty=random.randint(1, 3), image=""),
        Product(id="pd-5", name="Live Goat (Alpine)", category="Livestock", unit="head", price=4500, qty=random.randint(2, 5), image=""),
        Product(id="pd-6", name="Live Pig (Fattener)", category="Livestock", unit="head", price=8000, qty=random.randint(3, 8), image=""),
        Product(id="pd-7", name="Live Chicken (Native)", category="Livestock", unit="head", price=250, qty=random.randint(10, 20), image=""),
        Product(id="pd-8", name="Lanzones", category="Fresh Produce", unit="kg", price=120, qty=50, image=""),
        Product(id="pd-9", name="Mango", category="Fresh Produce", unit="kg", price=90, qty=80, image=""),
        Product(id="pd-10", name="Dragon Fruit", category="Fresh Produce", unit="kg", price=150, qty=30, image=""),
        Product(id="pd-11", name="Avocado", category="Fresh Produce", unit="kg", price=110, qty=40, image=""),
        Product(id="pd-12", name="Buko (Young Coconut)", category="Fresh Produce", unit="piece", price=35, qty=100, image=""),
        Product(id="pd-13", name="Rambutan (Fresh)", category="Fresh Produce", unit="kg", price=80, qty=120, image="")
    ])

    db.session.add_all([
        Task(id="tk-h1", type="Vaccination", targetType="livestock", target="lv-pi1", targetLabel="Pig PIG-I11", date=dt(0), assignedTo="u-hand1", priority="High", status="Due", remarks="Auto: Assigned due to Needs Attention status"),
        Task(id="tk-h2", type="Deworming", targetType="livestock", target="lv-g2", targetLabel="Goat GOT-102", date=dt(0), assignedTo="u-hand1", priority="High", status="Due", remarks="Auto: Assigned due to Needs Attention status"),
        Task(id="tk-2", type="Watering", targetType="crop", target="cp-1", targetLabel="Rambutan Plot CR-001", date=dt(-1), assignedTo="u-hand1", priority="Normal", status="Overdue", remarks="")
    ])

    db.session.commit()
    print("Seeded database with requested HarvTrack parameters.")

def migrate_database():
    """Upgrade an existing database in place (safe to run on every start)."""
    insp = inspect(db.engine)
    tables = insp.get_table_names()
    # 1. reorder level for low-stock alerts
    if 'inventory' in tables and 'reorderLevel' not in {c['name'] for c in insp.get_columns('inventory')}:
        db.session.execute(text('ALTER TABLE inventory ADD COLUMN "reorderLevel" FLOAT DEFAULT 5'))
        db.session.commit()
        print("Migrated: added inventory.reorderLevel")
    # 2. hashes are longer than the old 100-character column (PostgreSQL enforces length)
    if 'user' in tables and db.engine.dialect.name == 'postgresql':
        db.session.execute(text('ALTER TABLE "user" ALTER COLUMN password TYPE VARCHAR(255)'))
        db.session.commit()
    # 3. hash any plain-text passwords left from the old version
    changed = 0
    if 'user' in tables:
        for u in User.query.all():
            if not is_hashed(u.password):
                u.password = hash_pw(u.password or ''); changed += 1
        if changed:
            db.session.commit()
            print(f"Migrated: hashed {changed} plain-text password(s)")

def init_database():
    db.create_all()
    migrate_database()
    if not User.query.first():
        seed_database()

if __name__ == "__main__":
    with app.app_context():
        init_database()
    if app.config['SECRET_KEY'] == 'dev-only-change-me':
        print("WARNING: HT_SECRET is not set - using the development secret. Set HT_SECRET in production.")
    print("Starting HarvTrack Flask Server on http://localhost:8000")
    # Debug mode exposes an interactive debugger; enable it only on your own machine with HT_DEBUG=1
    app.run(host=os.environ.get('HT_HOST', '127.0.0.1'), port=8000, debug=os.environ.get('HT_DEBUG') == '1')
