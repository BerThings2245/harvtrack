(async function(){
"use strict";

var TODAY = new Date(); TODAY.setHours(0,0,0,0);
function todayISO(){ return TODAY.toISOString().slice(0,10); }
function daysFromToday(n){ var d=new Date(TODAY); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }
function fmtDate(iso){ var d=new Date(iso+"T00:00:00"); return d.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'}); }
function uid(p){ return p+"-"+Math.random().toString(36).slice(2,8); }

function normalizePhone(v){ return String(v||"").replace(/\D/g,""); }
function isValidPHPhone(v){ return /^09\d{9}$/.test(normalizePhone(v)); } 
function isValidEmail(v){ return /^\S+@\S+\.\S+$/.test(String(v||"").trim()); }

var CROP_STAGES = ["Growing","Flowering","Fruiting","Harvested"];
function nextCropStage(cur){ var i=CROP_STAGES.indexOf(cur); return i>-1 && i<CROP_STAGES.length-1 ? CROP_STAGES[i+1] : null; }

var state = { currentUser: null };
var cart = []; 
var reportFilter = {from: '', to: ''};

var authToken = null;   // signed login token from /api/login (kept in memory only)

function authHeaders(extra) {
  var h = Object.assign({}, extra || {});
  if (authToken) h['Authorization'] = 'Bearer ' + authToken;
  return h;
}

// POST JSON to the API. Resolves {ok, status, data}; rejects only on network failure.
async function postJSON(url, body) {
  var res = await fetch(url, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  var data = {};
  try { data = await res.json(); } catch(e) {}
  if (res.status === 401 && authToken) sessionExpired();
  return { ok: res.ok && data.success !== false, status: res.status, data: data };
}

function sessionExpired(){ toast("Session expired. Please log in again."); doLogout(); }

// Errors already shown to the user as a toast are marked handled so they are not logged as crashes
window.addEventListener('unhandledrejection', function(e){ if (e.reason && e.reason.handled) e.preventDefault(); });

async function reloadState() {
  if (!authToken) { applyTheme(localStorage.getItem('harvtrack_theme') || 'system'); return; }
  try {
    let res = await fetch('/api/state', { headers: authHeaders() });
    if (res.status === 401) { sessionExpired(); return; }
    let data = await res.json();
    let cu = state.currentUser;
    state = data;
    if(cu) state.currentUser = state.users.find(u => u.id === cu.id);

    var savedTheme = localStorage.getItem('harvtrack_theme') || state.settings.theme;
    applyTheme(savedTheme);
  } catch(e) { console.error("Failed to load state", e); }
}

async function apiAction(action, payload) {
  if (!navigator.onLine) {
    let queue = JSON.parse(localStorage.getItem('harvtrack_offline_queue') || '[]');
    queue.push({ action, payload, time: new Date().toISOString() });
    localStorage.setItem('harvtrack_offline_queue', JSON.stringify(queue));
    toast("Offline mode. Action saved locally.");
    return;
  }
  try {
    document.body.style.cursor = 'wait';
    var r = await postJSON('/api/action', { action, payload });
    if (!r.ok) {
      var msg = (r.data && r.data.error) || "The server rejected that action.";
      if (r.status !== 401) toast(esc(msg));
      var rejected = new Error(msg); rejected.handled = true; throw rejected;
    }
    await reloadState();
    return r.data;
  } catch(e) {
    if (e.handled) throw e;
    toast("Network error. Please try again.");
    e.handled = true; throw e;
  } finally {
    document.body.style.cursor = 'default';
  }
}

async function uploadFile(file) {
  let formData = new FormData();
  formData.append('file', file);
  let res = await fetch('/api/upload', { method: 'POST', headers: authHeaders(), body: formData });
  let data = await res.json();
  if(!data.success) throw new Error(data.error);
  return data.path;
}

window.addEventListener('online', async () => {
  let queue = JSON.parse(localStorage.getItem('harvtrack_offline_queue') || '[]');
  if (queue.length > 0 && authToken) {
    toast(`Syncing ${queue.length} offline actions...`);
    var rejectedCount = 0;
    for (let item of queue) {
      try { var r = await postJSON('/api/action', { action: item.action, payload: item.payload }); if (!r.ok) rejectedCount++; }
      catch (e) { console.error("Sync failed", e); rejectedCount++; }
    }
    localStorage.removeItem('harvtrack_offline_queue');
    await reloadState();
    if(authToken && document.getElementById("app").style.display !== "none") renderPage();
    toast(rejectedCount ? rejectedCount+" offline action(s) were rejected by the server." : "Data synchronized successfully!");
  }
});

function applyTheme(t){
  var root = document.documentElement;
  if(t==='light') root.setAttribute('data-theme','light');
  else if(t==='dark') root.setAttribute('data-theme','dark');
  else root.removeAttribute('data-theme');
}

function toast(msg){
  var w=document.getElementById("toastWrap");
  var t=document.createElement("div"); t.className="toast"; 
  t.innerHTML = `<span class="material-symbols-rounded">info</span> ${msg}`;
  w.appendChild(t); setTimeout(function(){ t.remove(); },3200);
}

function customConfirm(title, text, type, onConfirm) {
  var bg = document.createElement("div"); bg.className = "confirm-bg";
  var ic = type === 'danger' ? 'warning' : 'help';
  var btnClass = type === 'danger' ? 'btn-sm danger' : 'btn-sm primary';
  bg.innerHTML = '<div class="confirm-card"><div class="ic"><span class="material-symbols-rounded">'+ic+'</span></div><h3>'+esc(title)+'</h3><p>'+esc(text)+'</p><div class="confirm-actions"><button class="btn-sm" id="ccCancel">Cancel</button><button class="'+btnClass+'" id="ccConfirm">Confirm</button></div></div>';
  document.body.appendChild(bg);
  document.getElementById("ccCancel").onclick = () => bg.remove();
  document.getElementById("ccConfirm").onclick = () => { bg.remove(); onConfirm(); };
}

var route = "dashboard";
var NAV = {
  owner:[["dashboard","space_dashboard","Dashboard"],["livestock","cruelty_free","Livestock"],["crops","forest","Crops"],["tasks","task_alt","Tasks"],["inventory","inventory_2","Inventory"],["products","sell","Products"],["expenses","payments","Expenses"],["orders","shopping_cart","Orders"],["sales","trending_up","Sales"],["reports","bar_chart","Reports"],["notifications","notifications","Alerts"],["users","group","Users"],["settings","settings","Settings"]],
  farmhand:[["dashboard","space_dashboard","Home"],["mytasks","task_alt","My Tasks"],["livestock","cruelty_free","Livestock"],["crops","forest","Crops"],["notifications","notifications","Alerts"],["profile","account_circle","Profile"]],
  buyer:[["dashboard","storefront","Marketplace"],["cart","shopping_cart","My Cart"],["myorders","receipt_long","My Orders"],["notifications","notifications","Alerts"],["profile","account_circle","Profile"]]
};

function renderSidebar(){
  var role = state.currentUser.role;
  var items = NAV[role];
  var html = '<div class="brandmark"><span class="material-symbols-rounded leaf-icon">eco</span> HarvTrack</div><div class="nav-links">';
  items.forEach(function(it){
    var isCart = (it[0]==='cart' && cart.length>0);
    html += '<button class="navitem'+(route===it[0]?' active':'')+'" data-route="'+it[0]+'"><span class="ic"><span class="material-symbols-rounded">'+it[1]+'</span></span>'+it[2]+(isCart?' <span class="dot" style="margin-left:auto;background:var(--danger);padding:2px 8px;border-radius:12px;color:#fff;font-size:11px;font-weight:bold">'+cart.length+'</span>':'')+'</button>';
  });
  html += '</div><div class="foot"><button class="navitem" data-route="logout"><span class="ic"><span class="material-symbols-rounded">logout</span></span> Log out</button></div>';
  document.getElementById("sidebar").innerHTML = html;
  
  var bn='';
  items.forEach(function(it){ bn+='<button class="'+(route===it[0]?'active':'')+'" data-route="'+it[0]+'"><div style="font-size:22px"><span class="material-symbols-rounded">'+it[1]+'</span></div>'+it[2]+'</button>'; });
  document.getElementById("bottomnav").innerHTML = bn;
  
  document.querySelectorAll("[data-route]").forEach(function(b){
    b.onclick=function(){ var r=b.getAttribute("data-route"); if(r==="logout"){ doLogout(); } else { route=r; renderPage(); renderSidebar(); } };
  });
}

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function unreadCount(){ return state.notifications.filter(n=> n.userId===state.currentUser.id && !n.read).length; }
function refreshBell(){
  var c = unreadCount(); var dot = document.getElementById("bellDot");
  if(c>0){ dot.textContent=c; dot.classList.remove("hidden"); } else { dot.classList.add("hidden"); }
}

function renderPage(){
  var role = state.currentUser.role;
  document.getElementById("whoName").textContent = state.currentUser.name;
  refreshBell();
  var titles = {dashboard: role==='buyer'?'Marketplace':'Dashboard', livestock:'Livestock', crops:'Crops', tasks:'Tasks & Reminders', mytasks:'My Tasks', inventory:'Inventory', products:'Manage Products', expenses:'Expenses', orders:'Buyer Orders', sales:'Sales', reports:'Reports', notifications:'Notifications', cart:'Shopping Cart', myorders:'My Orders', users:'Users', settings:'Settings', profile:'My Profile'};
  document.getElementById("pageTitle").textContent = titles[route] || 'Dashboard';
  var body = document.getElementById("pageBody");
  
  if(route==='dashboard') body.innerHTML = role==='owner'?ownerDashboard(): role==='farmhand'?farmhandHome(): buyerProducts();
  else if(route==='livestock') body.innerHTML = livestockPage(role);
  else if(route==='crops') body.innerHTML = cropsPage(role);
  else if(route==='tasks') body.innerHTML = tasksPage(false);
  else if(route==='mytasks') body.innerHTML = tasksPage(true);
  else if(route==='inventory') body.innerHTML = inventoryPage();
  else if(route==='products') body.innerHTML = ownerProductsPage();
  else if(route==='expenses') body.innerHTML = expensesPage();
  else if(route==='orders') body.innerHTML = ordersPage();
  else if(route==='sales') body.innerHTML = salesPage();
  else if(route==='reports') body.innerHTML = reportsPage();
  else if(route==='notifications') body.innerHTML = notificationsPage();
  else if(route==='cart') body.innerHTML = buyerCartPage();
  else if(route==='myorders') body.innerHTML = myOrdersPage();
  else if(route==='users') body.innerHTML = role==='owner'? usersPage() : empty('lock','No access.','');
  else if(route==='settings') body.innerHTML = role==='owner'? settingsPage() : empty('lock','No access.','');
  else if(route==='profile') body.innerHTML = profilePage();
  wireEvents();
}

function ownerDashboard(){
  var totalLivestock = Object.values(state.livestockTotals).reduce((a,b)=>a+b,0);
  var activeTasks = state.tasks.filter(t=>t.status!=='Completed').length;
  var lowStock = state.inventory.filter(i=>i.qty<=(i.reorderLevel||0)).length;
  var pendingOrders = state.orders.filter(o=>o.status==='Pending').length;
  var income = state.orders.filter(o=>o.status==='Completed').reduce((a,o)=>a+o.total,0);
  var readyToHarvest = state.cropPlots.filter(c=>c.growthStage==='Fruiting').length;
  
  var html = '<div class="grid g4">'+stat('cruelty_free',totalLivestock,'Total Livestock')+stat('forest',state.cropPlots.length,'Active Crop Plots')+stat('schedule',activeTasks,'Active Tasks')+stat('inventory_2',lowStock,'Low / Out of Stock Items')+'</div>'+
             '<div class="grid g3" style="margin-top:20px">'+stat('shopping_cart',pendingOrders,'Pending Orders')+stat('payments','₱'+income.toLocaleString(),'Completed Sales Income')+stat('local_florist',readyToHarvest,'Plots Ready to Harvest')+'</div>';
  html += '<div class="section-title">Today\'s Farm Activity</div>';
  var todays = state.tasks.filter(t=>t.date<=todayISO() && t.status!=='Completed');
  html += todays.length? '<div class="tablewrap"><table><tr><th>Task</th><th>For</th><th>Assigned</th><th>Status</th></tr>' +
    todays.map(t=> '<tr><td>'+t.type+'</td><td>'+esc(t.targetLabel)+'</td><td>'+userName(t.assignedTo)+'</td><td>'+badge(t.status)+'</td></tr>').join('') + '</table></div>' : empty('task_alt','No tasks due right now.','');
  html += '<div class="section-title">Quick Actions</div><div class="toolbar">' +
    btnSm('addLivestock','<span class="material-symbols-rounded">add</span> Livestock',true)+btnSm('addCrop','<span class="material-symbols-rounded">add</span> Crop Plot',true)+btnSm('addTask','<span class="material-symbols-rounded">add</span> Task',true)+btnSm('addInventory','<span class="material-symbols-rounded">add</span> Inventory',true)+btnSm('addExpense','<span class="material-symbols-rounded">add</span> Expense',false)+btnSm('goReports','View Reports',false)+'</div>';
  return html;
}
function stat(ic,num,lbl){ return '<div class="card stat"><div class="top"><div class="ic"><span class="material-symbols-rounded">'+ic+'</span></div></div><div class="num">'+num+'</div><div class="lbl">'+lbl+'</div></div>'; }
function empty(ic,text,actHtml){ return '<div class="empty"><div class="big"><span class="material-symbols-rounded">'+ic+'</span></div><div style="font-size:16px;font-weight:500;margin-bottom:16px">'+text+'</div>'+(actHtml?'<div class="act">'+actHtml+'</div>':'')+'</div>'; }
function badge(status){
  var m={Due:'b-warn',Overdue:'b-danger',Completed:'b-ok',Pending:'b-muted',Rescheduled:'b-warn',Healthy:'b-ok',Confirmed:'b-ok',Rejected:'b-danger',Growing:'b-muted',Flowering:'b-warn',Fruiting:'b-ok',Harvested:'b-ok', 'In Stock':'b-ok', 'Low Stock':'b-warn', 'Out of Stock':'b-danger'};
  return '<span class="badge '+(m[status]||'b-muted')+'">'+status+'</span>';
}
function btnSm(action,label,primary){ return '<button class="btn-sm'+(primary?' primary':'')+'" data-action="'+action+'">'+label+'</button>'; }
function userName(id){ var u=state.users.find(x=>x.id===id); return u?u.name:'—'; }

function farmhandHome(){
  var mine = state.tasks.filter(t=>t.assignedTo===state.currentUser.id);
  var pending = mine.filter(t=>t.status!=='Completed');
  var html = '<div class="grid g2">'+stat('assignment',pending.length,"All Active Tasks")+'</div>';
  html += '<div class="section-title">Your Active Tasks</div>';
  pending.sort((a,b)=> a.date<b.date?-1:1);
  html += pending.length? pending.map(t=>taskCard(true,t)).join('') : empty('eco','You have no active tasks assigned.','');
  return html;
}

function tasksPage(mineOnly){
  var list = mineOnly? state.tasks.filter(t=>t.assignedTo===state.currentUser.id) : state.tasks.slice();
  list.sort((a,b)=> (a.status==='Completed'?-1:1) - (b.status==='Completed'?-1:1) || (a.date<b.date?-1:1));
  var html='';
  if(!mineOnly) html += '<div class="toolbar">'+btnSm('addTask','<span class="material-symbols-rounded">add</span> Create Task',true)+'<select id="taskFilter"><option value="">All statuses</option><option>Pending</option><option>Due</option><option>Overdue</option><option>Completed</option><option>Rescheduled</option></select></div>';
  html += '<div id="taskListWrap" class="grid g2">' + (list.length? list.map(t=>taskCard(mineOnly,t)).join('') : empty('assignment','No tasks scheduled.', mineOnly?'':btnSm('addTask','Create Task',true))) + '</div>';
  return html;
}
function taskCard(actionable,t){
  return '<div class="card" style="display:flex; justify-content:space-between; flex-direction:column; gap:12px" data-status="'+t.status+'"><div style="display:flex; justify-content:space-between; align-items:flex-start"><div><b style="font-size:16px">'+t.type+'</b><br><span style="color:var(--muted)">'+esc(t.targetLabel)+'</span></div>'+badge(t.status)+'</div>'+
    '<div style="font-size:13px; color:var(--muted); background:var(--bg); padding:10px; border-radius:8px; display:flex; gap:12px; align-items:center; flex-wrap:wrap"><span style="display:flex;align-items:center;gap:4px"><span class="material-symbols-rounded" style="font-size:16px">calendar_month</span> '+fmtDate(t.date)+'</span> <span style="display:flex;align-items:center;gap:4px"><span class="material-symbols-rounded" style="font-size:16px">account_circle</span> '+userName(t.assignedTo)+'</span> <span style="display:flex;align-items:center;gap:4px"><span class="material-symbols-rounded" style="font-size:16px">priority_high</span> Priority: '+t.priority+'</span>'+(t.remarks?'<div style="width:100%;display:flex;align-items:center;gap:4px"><span class="material-symbols-rounded" style="font-size:16px">edit_note</span> '+esc(t.remarks)+'</div>':'')+'</div>'+
    (actionable && t.status!=='Completed'? '<div style="display:flex;gap:10px;margin-top:auto"><button class="btn-sm primary" style="flex:1" data-action="completeTask" data-id="'+t.id+'">Complete</button><button class="btn-sm" style="flex:1" data-action="rescheduleTask" data-id="'+t.id+'">Reschedule</button></div>' : '')+
    '</div>';
}

function livestockPage(role){
  var totals = state.livestockTotals;
  var html = '<div class="grid g4">'+Object.keys(totals).map(k=>stat(iconFor(k),totals[k],'Total '+k+'s')).join('')+'</div>';
  var typeOptions = state.settings.livestockTypes.map(t => '<option>'+t+'</option>').join('');
  
  if(role==='owner') html += '<div class="toolbar" style="margin-top:20px">'+btnSm('addLivestock','<span class="material-symbols-rounded">add</span> Add Livestock',true)+'<input id="lvSearch" placeholder="Search tag..."><select id="lvTypeFilter"><option value="">All types</option>'+typeOptions+'</select></div>';
  else html += '<div class="section-title">Animal Roster</div>';
  
  html += '<div class="tablewrap" style="margin-top:'+(role==='owner'?'0':'12px')+'"><table id="lvTable"><tr><th>Tag</th><th>Type</th><th>Breed</th><th>Gender</th><th>Health</th><th></th></tr>'+
    state.livestock.map(a=>{ 
      let hb;
      if (a.health === 'Needs Attention') {
        hb = '<button class="btn-sm danger" data-action="viewHealthAlert" data-id="'+a.id+'"><span class="material-symbols-rounded" style="font-size:16px;margin-right:4px">warning</span> Needs Attention</button>';
      } else {
        hb = badge(a.health) + (a.health === 'Healthy' ? ' <button class="btn-sm" data-action="flagHealth" data-id="'+a.id+'">Flag issue</button>' : '');
      }
      return '<tr data-type="'+a.type+'" data-tag="'+a.tag.toLowerCase()+'"><td><b style="color:var(--forest)">'+a.tag+'</b></td><td><span class="material-symbols-rounded" style="color:var(--forest);margin-right:6px">'+iconFor(a.type)+'</span> '+a.type+'</td><td>'+a.breed+'</td><td>'+a.gender+'</td><td>'+hb+'</td>'+
      '<td>'+(role==='owner'?'<button class="btn-sm danger" data-action="removeLivestock" data-id="'+a.id+'">Remove</button>':'')+'</td></tr>'; 
    }).join('')+'</table></div>';
  return html;
}
function iconFor(type){ return {Goat:'cruelty_free',Pig:'pest_control',Cow:'agriculture',Chicken:'egg',Rambutan:'local_florist',Lanzones:'spa',Mango:'park',Avocado:'nutrition','Dragon Fruit':'filter_vintage','Buko Trees':'forest'}[type] || 'grass'; }

function inventoryPage(){
  var html = '<div class="toolbar">'+btnSm('addInventory','<span class="material-symbols-rounded">add</span> Add Inventory',true)+btnSm('stockTx','Record Stock In/Out',false)+'</div>';
  html += '<div class="tablewrap"><table><tr><th>Item</th><th>Category</th><th>On Hand</th><th>Reorder At</th><th>Status</th></tr>'+
    state.inventory.map(i=>{ 
      var lvl = i.reorderLevel||0;
      var st = i.qty <= 0 ? 'Out of Stock' : (i.qty <= lvl ? 'Low Stock' : 'In Stock'); 
      return '<tr><td><b>'+esc(i.name)+'</b></td><td>'+i.category+'</td><td><b style="font-size:16px">'+i.qty+'</b> '+i.unit+'</td><td>'+lvl+' '+i.unit+'</td><td>'+badge(st)+'</td></tr>'; 
    }).join('')+'</table></div>';
  return html;
}

function ownerProductsPage(){
  var html = '<div class="toolbar">'+btnSm('addProductModal','<span class="material-symbols-rounded">add</span> Add Product',true)+'</div>';
  if(!state.products.length) return html + empty('sell','No products listed for sale yet.','');
  
  html += '<div class="tablewrap"><table><tr><th>Product Name</th><th>Category</th><th>Price</th><th>Available Qty</th><th>Status</th><th></th></tr>'+
    state.products.map(p=>{ 
      var st = p.qty > 0 ? 'In Stock' : 'Out of Stock'; 
      return '<tr><td><b>'+esc(p.name)+'</b></td><td>'+p.category+'</td><td><b>₱'+p.price+'</b> / '+p.unit+'</td><td>'+p.qty+' '+p.unit+'</td><td>'+badge(st)+'</td>'+
      '<td><button class="btn-sm" data-action="editProductModal" data-id="'+p.id+'">Edit</button> <button class="btn-sm danger" data-action="deleteProduct" data-id="'+p.id+'">Delete</button></td></tr>'; 
    }).join('')+'</table></div>';
  return html;
}

function ordersPage(){
  var list = state.orders.slice().sort((a,b)=>b.time<a.time?-1:1);
  if(!list.length) return empty('shopping_cart','No pending buyer orders.','');
  return '<div class="tablewrap"><table><tr><th>Order ID</th><th>Buyer</th><th>Product</th><th>Qty</th><th>Total</th><th>Method</th><th>Status</th><th></th></tr>'+
    list.map(o=> '<tr><td><b style="color:var(--muted)">#'+o.id.slice(-5)+'</b></td><td>'+userName(o.buyerId)+'</td><td><b>'+esc(o.productName)+'</b></td><td>'+o.qty+' '+o.unit+'</td><td><b>₱'+o.total.toLocaleString()+'</b></td><td><span class="material-symbols-rounded" style="font-size:18px;margin-right:4px;vertical-align:bottom">'+(o.deliveryType==='Delivery'?'local_shipping':'storefront')+'</span>'+(o.deliveryType==='Delivery'?' Delivery':' Pickup')+'</td><td>'+badge(o.status)+'</td><td>'+
      (o.status==='Pending'? '<div style="display:flex;gap:6px"><button class="btn-sm primary" data-action="confirmOrder" data-id="'+o.id+'">Confirm</button> <button class="btn-sm danger" data-action="rejectOrder" data-id="'+o.id+'">Reject</button></div>' :
       o.status==='Confirmed'? '<button class="btn-sm primary" data-action="completeOrder" data-id="'+o.id+'">Mark Completed</button>' : '—') +
      '</td></tr>').join('')+'</table></div>';
}

function salesPage(){
  var done = state.orders.filter(o=>o.status==='Completed');
  var totalRev = done.reduce((a,o)=>a+o.total,0);
  var html = '<div class="grid g3">'+stat('payments','₱'+totalRev.toLocaleString(),'Total Sales Revenue')+stat('receipt_long',done.length,'Completed Orders')+stat('trending_up', done.length? '₱'+Math.round(totalRev/done.length).toLocaleString():'₱0','Average Order Value')+'</div>';
  html += '<div class="section-title">Sales by Product</div>';
  if(!done.length){ html += empty('bar_chart','No data available for the selected period.',''); return html; }
  var byProd={}; done.forEach(o=> byProd[o.productName]=(byProd[o.productName]||0)+o.total);
  html += '<div class="tablewrap"><table><tr><th>Product</th><th>Revenue</th></tr>'+Object.keys(byProd).map(p=>'<tr><td><b>'+esc(p)+'</b></td><td>₱'+byProd[p].toLocaleString()+'</td></tr>').join('')+'</table></div>';
  return html;
}

function cropsPage(role){
  var counts = {}; CROP_STAGES.forEach(s=>counts[s]=0);
  state.cropPlots.forEach(c=> counts[c.growthStage]=(counts[c.growthStage]||0)+1);
  var html = '<div class="grid g4">'+stat('grass',counts.Growing||0,'Growing')+stat('filter_vintage',counts.Flowering||0,'Flowering')+stat('local_florist',counts.Fruiting||0,'Fruiting (Ready Soon)')+stat('shopping_basket',counts.Harvested||0,'Harvested')+'</div>';
  if(role==='owner'){
    html += '<div class="toolbar" style="margin-top:20px">'+btnSm('addCrop','<span class="material-symbols-rounded">add</span> Add Crop Plot',true)+
      '<input id="cropSearch" placeholder="Search plot..."><select id="cropStageFilter"><option value="">All stages</option>'+CROP_STAGES.map(s=>'<option>'+s+'</option>').join('')+'</select></div>';
  } else { html += '<div class="section-title">Crop Plots</div>'; }
  if(!state.cropPlots.length){ html += empty('forest','No crop plots yet.', role==='owner'?btnSm('addCrop','Add Crop Plot',true):''); return html; }
  html += '<div class="tablewrap" style="margin-top:'+(role==='owner'?'0':'12px')+'"><table id="cropTable"><tr><th>Plot ID</th><th>Crop</th><th>Location</th><th>Area</th><th>Stage</th><th>Last Updated</th><th></th></tr>'+
    state.cropPlots.map(c=> '<tr data-stage="'+c.growthStage+'" data-search="'+(c.plotId+' '+c.cropType).toLowerCase()+'"><td><b style="color:var(--forest)">'+c.plotId+'</b></td><td><span class="material-symbols-rounded" style="color:var(--forest);margin-right:6px">'+iconFor(c.cropType)+'</span> '+c.cropType+'</td><td>'+esc(c.location)+'</td><td>'+esc(c.area)+'</td><td>'+badge(c.growthStage)+'</td><td>'+fmtDate(c.lastUpdated)+'</td>'+
        '<td><div style="display:flex;gap:6px"><button class="btn-sm primary" data-action="viewCropDetails" data-id="'+c.id+'">Timeline</button> '+(role==='owner'?'<button class="btn-sm danger" data-action="deleteCrop" data-id="'+c.id+'">Delete</button>':'')+'</div></td></tr>').join('')+'</table></div>';
  return html;
}

function expensesPage(){
  var exps = state.expenses.slice().sort((a,b)=>a.date<b.date?1:-1);
  var total = exps.reduce((a,e)=>a+e.amount,0);
  var thisMonth = exps.filter(e=>e.date.slice(0,7)===todayISO().slice(0,7)).reduce((a,e)=>a+e.amount,0);
  var html = '<div class="grid g3">'+stat('payments','₱'+total.toLocaleString(),'Total Expenses')+stat('calendar_month','₱'+thisMonth.toLocaleString(),'Expenses This Month')+stat('receipt_long',exps.length,'Recorded Expenses')+'</div>';
  html += '<div class="toolbar" style="margin-top:20px">'+btnSm('addExpense','<span class="material-symbols-rounded">add</span> Record Expense',true)+
    '<select id="expCatFilter"><option value="">All categories</option><option>Feed</option><option>Fertilizer</option><option>Seedlings</option><option>Veterinary</option><option>Labor</option><option>Other Farm Costs</option></select></div>';
  if(!exps.length){ html += empty('payments','No expenses recorded yet.', btnSm('addExpense','Record Expense',true)); return html; }
  html += '<div class="tablewrap" id="expTableWrap"><table><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Recorded By</th></tr>'+
    exps.map(e=> '<tr data-cat="'+e.category+'"><td>'+fmtDate(e.date)+'</td><td><b>'+e.category+'</b></td><td>'+esc(e.description)+'</td><td><b style="color:var(--danger-text)">₱'+e.amount.toLocaleString()+'</b></td><td>'+userName(e.recordedBy)+'</td></tr>').join('')+'</table></div>';
  return html;
}

function reportsPage(){
  var from = reportFilter.from, to = reportFilter.to;
  function inRange(d){ return (!from||d>=from) && (!to||d<=to); }
  var html = '<div class="toolbar"><div class="field" style="margin:0"><label>From</label><input id="rfFrom" type="date" value="'+from+'"></div><div class="field" style="margin:0"><label>To</label><input id="rfTo" type="date" value="'+to+'"></div><button class="btn-sm" data-action="clearReportFilter" style="align-self:flex-end">Clear</button></div>';
  var yields = state.yieldRecords.filter(y=>inRange(y.harvestDate));
  html += '<div class="section-title"><span class="material-symbols-rounded" style="margin-right:8px;color:var(--forest)">local_florist</span> Yield Report</div>';
  if(yields.length){ var byCrop={}; yields.forEach(y=>{ var kk=y.cropType+'|'+(y.unit||'kg'); byCrop[kk]=(byCrop[kk]||0)+y.quantity; }); html += '<div class="card">'+Object.keys(byCrop).map(k=>`<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:12px 0"><b>${esc(k.split('|')[0])}</b><span>${Math.round(byCrop[k]*100)/100} ${esc(k.split('|')[1])}</span></div>`).join('')+'</div>'; } else html += empty('agriculture','No data.','');
  var exps = state.expenses.filter(e=>inRange(e.date));
  html += '<div class="section-title"><span class="material-symbols-rounded" style="margin-right:8px;color:var(--danger-text)">payments</span> Expense Report</div>';
  if(exps.length){ var byCat={}; exps.forEach(e=> byCat[e.category]=(byCat[e.category]||0)+e.amount); html += '<div class="card">'+Object.keys(byCat).map(k=>`<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:12px 0"><b>${k}</b><span style="color:var(--danger-text)">₱${byCat[k].toLocaleString()}</span></div>`).join('')+'</div>'; } else html += empty('payments','No data.','');
  var sales = state.orders.filter(o=>o.status==='Completed' && inRange(o.time));
  html += '<div class="section-title"><span class="material-symbols-rounded" style="margin-right:8px;color:var(--ok-text)">trending_up</span> Income Report</div>';
  if(sales.length){ var byProd={}; sales.forEach(o=> byProd[o.productName]=(byProd[o.productName]||0)+o.total); html += '<div class="card">'+Object.keys(byProd).map(k=>`<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:12px 0"><b>${k}</b><span style="color:var(--ok-text)">₱${byProd[k].toLocaleString()}</span></div>`).join('')+'</div>'; } else html += empty('trending_up','No data.','');
  return html;
}

function routeForNotification(type){
  if(state.currentUser.role === 'farmhand' && (type === 'Task Reminder' || type === 'Overdue Task')) return 'mytasks';
  return { 'Low Stock':'inventory', 'Task Reminder':'tasks', 'Overdue Task':'tasks', 'New Order':'orders', 'Order Update':'myorders' }[type] || 'dashboard';
}
function notificationsPage(){
  var mine = state.notifications.filter(n=>n.userId===state.currentUser.id).sort((a,b)=>b.time.localeCompare(a.time));
  var html = '<div class="toolbar"><button class="btn-sm primary" data-action="markAllRead">Mark all as read</button></div>';
  html += '<div class="grid g1">'+ (mine.length? mine.map(n=> '<div class="card" style="display:flex;gap:16px;padding:16px;cursor:pointer;border-left:4px solid '+(n.read?'transparent':'var(--forest)')+'" data-route="'+routeForNotification(n.type)+'" onclick="route=this.getAttribute(\'data-route\');renderSidebar();renderPage();"><div style="font-size:24px;background:var(--bg);padding:12px;border-radius:14px;color:var(--forest)"><span class="material-symbols-rounded">'+({'Low Stock':'inventory_2','Task Reminder':'schedule','Overdue Task':'warning','New Order':'shopping_cart','Order Update':'task_alt','Order Rejected':'cancel','IoT Alert':'sensors'}[n.type]||'notifications')+'</span></div><div><b style="font-size:15px">'+n.type+'</b><div style="margin:4px 0">'+esc(n.text)+'</div><div style="font-size:12px;color:var(--muted)">'+fmtDate(n.time)+'</div></div></div>').join('') : empty('notifications','No notifications yet.','')) +'</div>';
  return html;
}

function buyerProducts(){
  var html = '<div class="marketplace-search"><input type="text" id="buyerSearchInput" placeholder="Search for fresh produce, eggs, livestock..."><button class="btn-sm primary" id="buyerSearchBtn"><span class="material-symbols-rounded">search</span> Search</button></div>';
  
  html += '<div class="grid g3" id="buyerProductsGrid">'+state.products.map(p=>{
    var avail = p.qty>0;
    var picHtml = p.image ? '<img src="'+esc(p.image)+'">' : '<span class="material-symbols-rounded">'+({'Eggs':'egg','Livestock':'cruelty_free','Fresh Produce':'local_florist'}[p.category]||'grass')+'</span>';
    return '<div class="prod-card" data-name="'+p.name.toLowerCase()+'" data-cat="'+p.category.toLowerCase()+'"><div class="pic">'+picHtml+'</div><b style="font-size:18px">'+esc(p.name)+'</b><div style="color:var(--muted);font-size:14px;display:flex;justify-content:space-between"><span>'+p.category+'</span><b style="color:var(--fg)">₱'+p.price+' / '+p.unit+'</b></div>'+
      (avail? '<div style="font-size:13px;background:var(--bg);padding:6px 10px;border-radius:8px">Available: <b>'+p.qty+' '+p.unit+'</b></div>' : '<div style="font-size:13px;color:var(--danger-text);background:rgba(239, 68, 68, 0.1);padding:6px 10px;border-radius:8px">Out of stock</div>')+
      (avail? '<button class="btn-sm primary" data-action="addToCart" data-id="'+p.id+'" style="margin-top:auto"><span class="material-symbols-rounded">add_shopping_cart</span> Add to Cart</button>' : '<button class="btn-sm" disabled style="margin-top:auto">Unavailable</button>')+'</div>';
  }).join('')+'</div>';
  return html;
}

function buyerCartPage(){
  if(cart.length===0) return empty('shopping_cart','Your cart is empty.', btnSm('goProducts','Browse Marketplace',true));
  var total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
  var html = '<div class="grid g2" style="align-items:start"><div class="tablewrap" style="margin:0"><table><tr><th>Product</th><th>Price</th><th>Qty</th><th>Subtotal</th><th></th></tr>';
  cart.forEach((c, idx) => {
    html += '<tr><td><b>'+esc(c.name)+'</b></td><td>₱'+c.price+'</td><td>'+c.qty+' '+c.unit+'</td><td><b>₱'+(c.price*c.qty)+'</b></td><td><button class="btn-sm danger" data-action="removeCart" data-idx="'+idx+'">Remove</button></td></tr>';
  });
  html += '</table></div>';
  
  html += '<div class="card"><div class="section-title" style="margin-top:0">Order Summary</div>'+
    '<div style="font-size:32px;font-weight:800;margin-bottom:24px;color:var(--forest)">Total: ₱'+total.toLocaleString()+'</div>'+
    '<div class="field"><label>Fulfillment Method</label><select id="checkoutMethod"><option value="Pickup">Pickup at Farm (Free)</option><option value="Delivery">Local Delivery (COD)</option></select></div>'+
    '<div class="field hidden" id="checkoutAddressField"><label>Delivery Address</label><input id="checkoutAddress" placeholder="Enter complete home address"></div>'+
    '<div class="err hidden" id="checkoutErr"></div>'+
    '<button class="btn-sm primary" style="width:100%;margin-top:10px;padding:14px;font-size:16px" data-action="processCheckout">Place Order</button></div></div>';
  return html;
}

function myOrdersPage(){
  var mine = state.orders.filter(o=>o.buyerId===state.currentUser.id).sort((a,b)=>b.time<a.time?-1:1);
  if(!mine.length) return empty('receipt_long','You haven\'t placed any orders yet.',btnSm('goProducts','Browse Marketplace',true));
  return '<div class="tablewrap"><table><tr><th>Order ID</th><th>Product</th><th>Qty</th><th>Total</th><th>Method</th><th>Status</th><th>Actions</th></tr>'+
    mine.map(o=> '<tr><td><b style="color:var(--muted)">#'+o.id.slice(-5)+'</b></td><td><b>'+esc(o.productName)+'</b></td><td>'+o.qty+' '+o.unit+'</td><td><b>₱'+o.total.toLocaleString()+'</b></td><td><span class="material-symbols-rounded" style="font-size:18px;margin-right:4px;vertical-align:bottom">'+(o.deliveryType==='Delivery'?'local_shipping':'storefront')+'</span>'+(o.deliveryType==='Delivery'?' Delivery':' Pickup')+'</td><td>'+badge(o.status)+'</td><td>'+
      (o.status==='Pending'?'<button class="btn-sm danger" data-action="cancelOrder" data-id="'+o.id+'">Cancel</button>':'—')+'</td></tr>').join('')+'</table></div>';
}

function roleBadge(role){ return '<span class="badge '+(role==='owner'?'b-ok':role==='farmhand'?'b-warn':'b-muted')+'">'+role.charAt(0).toUpperCase()+role.slice(1)+'</span>'; }
function usersPage(){
  var html = '<div class="toolbar">'+btnSm('addUser','<span class="material-symbols-rounded">add</span> Add User',true)+'</div>';
  html += '<div class="tablewrap"><table><tr><th>Name</th><th>Role</th><th>Email</th><th>Contact</th><th>Status</th><th></th></tr>'+
    state.users.map(u=>{
      var isMe = u.id===state.currentUser.id;
      return '<tr><td><b>'+esc(u.name)+'</b>'+(isMe?' <span style="color:var(--muted);font-size:12px">(You)</span>':'')+'</td><td>'+roleBadge(u.role)+'</td><td>'+esc(u.email)+'</td><td>'+esc(u.phone||'—')+'</td>'+
        '<td><span class="badge '+(u.status==='Inactive'?'b-danger':'b-ok')+'">'+(u.status||'Active')+'</span></td>'+
        '<td>'+(isMe?'':'<button class="btn-sm'+(u.status==='Inactive'?' primary':'')+'" data-action="toggleUserStatus" data-id="'+u.id+'">'+(u.status==='Inactive'?'Activate':'Deactivate')+'</button> <button class="btn-sm danger" data-action="deleteUser" data-id="'+u.id+'">Delete</button>')+'</td></tr>';
    }).join('')+'</table></div>';
  return html;
}

function settingsPage(){
  var s = state.settings;
  var th = localStorage.getItem('harvtrack_theme') || s.theme || 'system';
  return '<div class="card" style="max-width:520px"><div class="section-title" style="margin-top:0">Farm Profile</div><div class="field"><label>Farm Name</label><input value="'+esc(s.farmName)+'" disabled></div><div class="field"><label>Location</label><input value="'+esc(s.location)+'" disabled></div></div>'+
    '<div class="card" style="max-width:520px;margin-top:24px"><div class="section-title" style="margin-top:0">Appearance</div><div class="field"><label>Theme</label><select id="setTheme" onchange="window.updateTheme(this.value)">'+['system','light','dark'].map(t=> '<option value="'+t+'"'+(th===t?' selected':'')+'>'+t.charAt(0).toUpperCase()+t.slice(1)+'</option>').join('')+'</select></div></div>';
}

window.updateTheme = async function(val) {
  applyTheme(val);
  localStorage.setItem('harvtrack_theme', val);
  await apiAction('updateSettings', {theme: val});
  toast("Theme updated successfully!");
};

function profilePage(){
  var u = state.currentUser;
  var initials = u.name.replace(/\(.*?\)/g,'').trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase();
  var html = '<div class="card" style="max-width:520px;display:flex;gap:20px;align-items:center"><div style="width:72px;height:72px;border-radius:50%;background:var(--grad-primary);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;font-family:Fraunces,serif;box-shadow:0 8px 24px rgba(5,150,105,0.3)">'+initials+'</div><div><div style="font-weight:800;font-size:22px">'+esc(u.name)+'</div><div style="margin-top:6px">'+roleBadge(u.role)+'</div></div></div>';
  html += '<div class="card" style="max-width:520px;margin-top:24px"><div class="section-title" style="margin-top:0">Account Details</div><div class="field"><label>Full Name</label><input id="pfName" value="'+esc(u.name)+'"></div><div class="field"><label>Email</label><input value="'+esc(u.email)+'" disabled></div><div class="field"><label>Contact Number</label><input id="pfPhone" value="'+esc(u.phone||'')+'" placeholder="09XX XXX XXXX" maxlength="13"></div><div class="err hidden" id="pfErr"></div><button class="btn-sm primary" data-action="saveProfile">Save Changes</button></div>';
  return html;
}

function openModal(html){
  var bg = document.createElement("div"); bg.className="modal-bg"; bg.id="modalBg";
  bg.innerHTML = '<div class="modal">'+html+'</div>';
  bg.addEventListener("click",function(e){ if(e.target===bg) closeModal(); });
  document.body.appendChild(bg);
  wireEvents();
}
function closeModal(){ var m=document.getElementById("modalBg"); if(m) m.remove(); }

function wireEvents(){
  var targetTypeSel = document.getElementById("mtTargetType");
  if(targetTypeSel) {
    targetTypeSel.onchange = function() {
      var val = this.value;
      var targetField = document.getElementById("mtTargetField");
      if(val === 'crop') {
        targetField.classList.remove('hidden');
        document.getElementById("mtTarget").innerHTML = state.cropPlots.map(c=>'<option value="'+c.id+'">'+c.cropType+' '+c.plotId+'</option>').join('');
        document.getElementById("mtType").innerHTML = '<option>Watering</option><option>Fertilizing</option><option>Harvesting</option>';
      } else if (val === 'livestock') {
        targetField.classList.remove('hidden');
        document.getElementById("mtTarget").innerHTML = state.livestock.map(a=>'<option value="'+a.id+'">'+a.type+' '+a.tag+'</option>').join('');
        document.getElementById("mtType").innerHTML = '<option>Feeding</option><option>Vaccination</option><option>Deworming</option>';
      } else {
        targetField.classList.add('hidden');
        document.getElementById("mtType").innerHTML = '<option>Delivery</option><option>Maintenance</option><option>Other</option>';
      }
    };
  }
  
  var checkoutSel = document.getElementById("checkoutMethod");
  if(checkoutSel) {
    checkoutSel.onchange = function() {
      var ad = document.getElementById("checkoutAddressField");
      if(this.value === 'Delivery') ad.classList.remove('hidden'); else ad.classList.add('hidden');
    };
  }
  
  var bSearchIn = document.getElementById("buyerSearchInput");
  var doBuyerSearch = function() {
    var query = (bSearchIn.value || "").toLowerCase();
    document.querySelectorAll('#buyerProductsGrid .prod-card').forEach(card => {
      var name = card.getAttribute('data-name');
      var cat = card.getAttribute('data-cat');
      card.style.display = (name.includes(query) || cat.includes(query)) ? '' : 'none';
    });
  };
  if(bSearchIn) bSearchIn.oninput = doBuyerSearch;
  var bSearchBtn = document.getElementById("buyerSearchBtn");
  if(bSearchBtn) bSearchBtn.onclick = doBuyerSearch;

  ["lvSearch","cropSearch"].forEach(id=>{ let el=document.getElementById(id); if(el) el.oninput=()=>applyFilters(); });
  ["lvTypeFilter","taskFilter","cropStageFilter","expCatFilter"].forEach(id=>{ let el=document.getElementById(id); if(el) el.onchange=()=>applyFilters(); });
  ["rfFrom","rfTo"].forEach(id=>{ let el=document.getElementById(id); if(el) el.onchange=()=>{ reportFilter[id.replace("rf","").toLowerCase()] = el.value; renderPage(); } });
  let bb = document.getElementById("bellBtn"); if(bb) bb.onclick=()=>{route="notifications";renderPage();renderSidebar();};

  document.querySelectorAll("[data-action]").forEach(function(el){
    el.onclick = async function(e){
      e.stopPropagation(); 
      var a = el.getAttribute("data-action"), id = el.getAttribute("data-id");
      var fns = {
        goToTasksForLivestock: () => {
          closeModal();
          route = (state.currentUser.role === 'farmhand') ? 'mytasks' : 'tasks';
          renderSidebar();
          renderPage();
          toast("Redirected to tasks.");
        },
        viewHealthAlert: () => {
          var a = state.livestock.find(x=>x.id===id);
          var activeTask = state.tasks.find(t => t.target === a.id && t.status !== 'Completed');
          var reason = activeTask ? (activeTask.type + (activeTask.remarks ? ' - ' + activeTask.remarks : '')) : 'Pending veterinary inspection.';
          openModal('<h3>Health Alert: '+a.type+' '+a.tag+'</h3>'+
            '<div class="card" style="background:rgba(245,158,11,0.1); border:1px solid var(--warn); margin-bottom:16px; padding:16px;">'+
            '<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;"><span class="material-symbols-rounded" style="font-size:24px;color:var(--warn)">warning</span><b style="color:var(--warn); font-size:16px;">Action Required</b></div>'+
            '<div style="color:var(--fg); font-size:14px; line-height:1.5;">'+esc(reason)+'</div></div>'+
            '<p style="margin-bottom:16px;font-size:14px;color:var(--muted)">You can manage the pending task or mark this animal as healthy once treatment is complete.</p>'+
            '<div class="field"><label>Resolution Notes (if marking healthy)</label><input id="mhNotes" placeholder="e.g. Administered medication"></div>'+
            '<div class="modal-actions" style="justify-content: space-between; align-items: center;">'+
            '<button class="btn-sm" data-action="goToTasksForLivestock">Go to Tasks Page</button>'+
            '<div style="display:flex; gap:10px;">'+
            '<button class="btn-sm" data-action="closeModal">Cancel</button>'+
            '<button class="btn-sm primary" data-action="saveHealth" data-id="'+id+'">Mark Healthy</button></div></div>');
        },
        addLivestock:()=>{
          let types = (state.settings.livestockTypes || []).map(t => `<option>${t}</option>`).join('');
          openModal('<h3>Add Livestock</h3><div class="formrow"><div class="field"><label>Type</label><select id="mType">'+types+'</select></div></div><div class="formrow"><div class="field"><label>Breed</label><input id="mBreed" placeholder="e.g. Fattener, Native"></div><div class="field"><label>Gender</label><select id="mGender"><option>Female</option><option>Male</option></select></div></div><div class="field"><label>Birth Date</label><input id="mBirth" type="date"></div><div class="err hidden" id="mErr"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm primary" data-action="saveLivestock">Save</button></div>');
        },
        saveLivestock:async ()=>{
          var type=document.getElementById("mType").value, breed=document.getElementById("mBreed").value.trim(), gender=document.getElementById("mGender").value, birth=document.getElementById("mBirth").value, err=document.getElementById("mErr");
          if(!breed||!birth){ err.textContent="Breed and Birth Date are required."; err.classList.remove("hidden"); return; }
          var countExisting = state.livestock.filter(l => l.type === type).length;
          var seq = (countExisting + 1).toString().padStart(3, '0');
          var randomNum = Math.floor(10 + Math.random() * 90);
          var prefix = type.substring(0,3).toUpperCase();
          var generatedTag = `${prefix}-${seq}-${randomNum}`;
          
          await apiAction('addLivestock', {id:uid("lv"),tag:generatedTag,type:type,breed:breed,gender:gender,birth:birth,health:"Healthy",registered:todayISO()});
          closeModal(); renderPage(); toast("Livestock "+generatedTag+" added.");
        },
        removeLivestock:()=>{
            openModal('<h3>Remove Livestock</h3><div class="field"><label>Reason for Removal</label><select id="mlvReason"><option>Sold</option><option>Died</option><option>Other / Error</option></select></div><div class="field"><label>Additional Notes</label><input id="mlvNotes" placeholder="Optional details"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm danger" data-action="confirmRemoveLivestock" data-id="'+id+'">Confirm Remove</button></div>');
        },
        confirmRemoveLivestock: async ()=>{
            var reason = document.getElementById("mlvReason").value;
            await apiAction('removeLivestock', {id:id, reason:reason});
            closeModal(); renderPage(); toast("Livestock permanently removed ("+reason+").");
        },
        saveHealth:async ()=>{ await apiAction('updateLivestockHealth', {id:id, health:"Healthy", remarks:document.getElementById("mhNotes").value||"Routine check", userId:state.currentUser.id}); closeModal(); renderPage(); toast("Health status updated."); },
        flagHealth:()=>{ var a=state.livestock.find(x=>x.id===id); if(!a) return;
          openModal('<h3>Flag Issue: '+esc(a.type)+' '+esc(a.tag)+'</h3><div class="field"><label>What is wrong?</label><input id="mfNotes" placeholder="e.g. Not eating, limping"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm danger" data-action="saveFlag" data-id="'+id+'">Mark Needs Attention</button></div>'); },
        saveFlag:async ()=>{ await apiAction('updateLivestockHealth', {id:id, health:"Needs Attention", remarks:document.getElementById("mfNotes").value||"Issue reported", userId:state.currentUser.id}); closeModal(); renderPage(); toast("Animal marked as Needs Attention."); },
        addTask:()=>{
          var lOpts = state.livestock.map(a=>'<option value="'+a.id+'">'+a.type+' '+a.tag+'</option>').join('');
          var hands = state.users.filter(u=>u.role==='farmhand').map(u=>'<option value="'+u.id+'">'+u.name+'</option>').join('');
          openModal('<h3>Create Task</h3><div class="formrow"><div class="field"><label>For</label><select id="mtTargetType"><option value="livestock">Livestock</option><option value="crop">Crop Plot</option><option value="general">General (e.g. Delivery)</option></select></div><div class="field"><label>Task Type</label><select id="mtType"><option>Feeding</option><option>Vaccination</option><option>Deworming</option></select></div></div><div class="formrow"><div class="field" id="mtTargetField"><label>Target</label><select id="mtTarget">'+lOpts+'</select></div><div class="field"><label>Assign To</label><select id="mtAssign">'+hands+'</select></div></div><div class="formrow"><div class="field"><label>Priority</label><select id="mtPriority"><option>Normal</option><option>High</option></select></div><div class="field"><label>Date</label><input id="mtDate" type="date" value="'+todayISO()+'"></div></div><div class="field"><label>Instructions</label><input id="mtRemarks" placeholder="Optional details"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm primary" data-action="saveTask">Create Task</button></div>');
        },
        saveTask:async ()=>{
          var type=document.getElementById("mtType").value, targetType=document.getElementById("mtTargetType").value, targetId=document.getElementById("mtTarget").value, targetLabel='—';
          if(targetType==='crop'){ var plot = state.cropPlots.find(c=>c.id===targetId); targetLabel = plot? plot.cropType+' Plot '+plot.plotId : '—'; }
          else if(targetType==='livestock') { var animal = state.livestock.find(a=>a.id===targetId); targetLabel = animal? animal.type+' '+animal.tag : '—'; }
          else { targetId = 'general'; targetLabel = 'General Task'; }
          
          await apiAction('addTask', {
              id:uid("tk"),type:type,targetType:targetType,target:targetId,targetLabel:targetLabel,
              date:document.getElementById("mtDate").value,assignedTo:document.getElementById("mtAssign").value,
              priority:document.getElementById("mtPriority").value,status:"Due",remarks:document.getElementById("mtRemarks").value
          });
          closeModal(); renderPage(); toast("Task created.");
        },
        completeTask:()=>{
          var t = state.tasks.find(x=>x.id===id); if(!t) return;
          var isHarvest = t.type==='Harvesting' && t.targetType==='crop';
          openModal('<h3>Complete Task: '+t.type+'</h3><p style="color:var(--muted);font-size:14px">'+esc(t.targetLabel)+'</p>'+(isHarvest? '<div class="formrow"><div class="field"><label>Harvest Qty</label><input id="mcQty" type="number" min="0" step="0.1" value=""></div><div class="field"><label>Unit</label><input id="mcUnit" value="kg"></div></div>' : '')+'<div class="field"><label>Remarks</label><input id="mcRemarks" placeholder="Optional details"></div><div class="err hidden" id="mcErr"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm primary" data-action="confirmCompleteTask" data-id="'+id+'">Confirm</button></div>');
        },
        confirmCompleteTask:async ()=>{
          var t = state.tasks.find(x=>x.id===id), isHarvest = t.type==='Harvesting' && t.targetType==='crop', qty=0, unit='kg';
          if(isHarvest){
            qty = parseFloat(document.getElementById("mcQty").value); unit = document.getElementById("mcUnit").value.trim()||'kg';
            if(!qty||qty<=0){ document.getElementById("mcErr").textContent="Enter harvest quantity."; document.getElementById("mcErr").classList.remove("hidden"); return; }
          }
          await apiAction('completeTask', {id:id, isHarvest:isHarvest, cropType:state.cropPlots.find(c=>c.id===t.target)?.cropType, qty:qty, unit:unit, remarks:document.getElementById("mcRemarks").value, userId:state.currentUser.id});
          closeModal(); renderPage(); toast("Task marked complete.");
        },
        rescheduleTask:()=>openModal('<h3>Reschedule Request</h3><div class="field"><label>Date</label><input id="mrDate" type="date"></div><div class="field"><label>Reason</label><input id="mrReason"></div><div class="modal-actions"><button class="btn-sm primary" data-action="confirmReschedule" data-id="'+id+'">Submit</button></div>'),
        confirmReschedule:async ()=>{ await apiAction('rescheduleTask', {id:id, date:document.getElementById("mrDate").value, reason:document.getElementById("mrReason").value}); closeModal(); renderPage(); toast("Requested."); },
        addCrop:()=>{
          let cropTypes = (state.settings.cropTypes || []).map(t => `<option>${t}</option>`).join('');
          openModal('<h3>Add Crop Plot</h3><div class="formrow"><div class="field"><label>Plot ID *</label><input id="mcpId"></div><div class="field"><label>Crop Type</label><select id="mcpType">'+cropTypes+'</select></div></div><div class="field"><label>Location</label><input id="mcpLoc" placeholder="e.g. Near Star Apple Fruit"></div><div class="field"><label>Area * (e.g. 1.5 hectares)</label><input id="mcpArea"></div><div class="err hidden" id="mcpErr"></div><div class="modal-actions"><button class="btn-sm primary" data-action="saveCrop">Save</button></div>');
        },
        saveCrop:async ()=>{
          var plotId=document.getElementById("mcpId").value.trim(), area=document.getElementById("mcpArea").value.trim();
          var err = document.getElementById("mcpErr");
          if(!plotId || !area) { err.textContent="Plot ID and Area are required."; err.classList.remove("hidden"); return; }
          await apiAction('addCrop', {id:uid("cp"),plotId:plotId,cropType:document.getElementById("mcpType").value,location:document.getElementById("mcpLoc").value.trim(),area:area,plantingDate:todayISO(),growthStage:"Growing",lastUpdated:todayISO()}); 
          closeModal(); renderPage(); toast("Crop plot added."); 
        },
        viewCropDetails:()=>{
          var c=state.cropPlots.find(x=>x.id===id);
          var stMap = {"Growing":"grass","Flowering":"filter_vintage","Fruiting":"local_florist","Harvested":"shopping_basket"};
          var stageHtml = '<div style="display:flex;gap:16px;margin:24px 0;align-items:center">';
          CROP_STAGES.forEach(s => {
            var isActive = (s === c.growthStage);
            var isPast = CROP_STAGES.indexOf(s) < CROP_STAGES.indexOf(c.growthStage);
            var col = isActive ? 'var(--forest)' : (isPast ? 'var(--forest-light)' : 'var(--line)');
            var weight = isActive ? '800' : '500';
            stageHtml += '<div style="text-align:center;flex:1"><div style="border:3px solid '+col+';width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 8px;background:var(--bg)"><span class="material-symbols-rounded" style="color:'+col+';font-size:24px">'+stMap[s]+'</span></div><div style="font-size:12px;color:'+col+';font-weight:'+weight+';text-transform:uppercase">'+s+'</div></div>';
          });
          stageHtml += '</div>';
          openModal('<h3>'+c.cropType+' '+c.plotId+'</h3>'+stageHtml+(state.currentUser.role==='owner'?'<div class="modal-actions" style="justify-content:flex-start;margin-top:16px;border-top:none;padding-top:0"><button class="btn-sm primary" data-action="advanceCropStage" data-id="'+id+'">Advance Stage</button></div>':'')+'<div class="modal-actions"><button class="btn-sm" data-action="closeModal">Close</button></div>');
        },
        advanceCropStage:async ()=>{ var n=nextCropStage(state.cropPlots.find(x=>x.id===id).growthStage); if(n) await apiAction('updateCropStage',{id:id, stage:n}); closeModal(); renderPage(); toast("Advanced to "+n); },
        deleteCrop: () => { customConfirm("Delete Crop Plot", "Are you sure you want to delete this crop plot?", "danger", async () => { await apiAction('deleteCrop', {id}); renderPage(); toast("Crop deleted."); }); },
        
        addToCart:()=>{
          var p=state.products.find(x=>x.id===id);
          openModal('<h3>Add '+esc(p.name)+'</h3><div class="field"><label>Quantity ('+esc(p.unit)+')</label><input id="moQty" type="number" min="1" max="'+p.qty+'" value="1"></div><div class="err hidden" id="moErr"></div><div class="modal-actions"><button class="btn-sm primary" data-action="confirmAddToCart" data-id="'+id+'">Add to Cart</button></div>');
        },
        confirmAddToCart:()=>{
          var p = state.products.find(x=>x.id===id), qty = parseFloat(document.getElementById("moQty").value);
          if(!qty||qty<1 || qty>p.qty){ document.getElementById("moErr").textContent="Invalid quantity."; document.getElementById("moErr").classList.remove("hidden"); return; }
          var existing = cart.find(c => c.productId === id);
          if(existing) { 
            if(existing.qty + qty > p.qty) { document.getElementById("moErr").textContent="Exceeds stock limit."; document.getElementById("moErr").classList.remove("hidden"); return; }
            existing.qty += qty; 
          }
          else cart.push({ productId: p.id, name: p.name, unit: p.unit, price: p.price, qty: qty });
          closeModal(); renderSidebar(); renderPage(); toast("Added to cart.");
        },
        removeCart:()=>{ 
          var idx = el.getAttribute("data-idx"); 
          cart.splice(idx,1); 
          renderSidebar(); renderPage(); toast("Removed item."); 
        },
        processCheckout:async ()=>{
          var method = document.getElementById("checkoutMethod").value, address = document.getElementById("checkoutAddress").value.trim();
          var err = document.getElementById("checkoutErr");
          if(method === 'Delivery' && !address) { err.textContent="Delivery address is required."; err.classList.remove("hidden"); return; }
          
          var failed = [], placed = 0;
          for(var i=0; i<cart.length; i++){
            var c = cart[i];
            // the server sets the buyer, price, status and date itself
            var r = await postJSON('/api/action', { action: 'submitOrder', payload: {id:uid("ord"), productId:c.productId, qty:c.qty, deliveryType:method, address:address} });
            if(r.ok) placed++; else failed.push({item:c, msg:(r.data&&r.data.error)||'Order failed'});
          }
          if(!authToken) return;                      // session expired during checkout
          cart = failed.map(f=>f.item);
          await reloadState();
          if(failed.length){
            route = "cart"; renderSidebar(); renderPage();
            toast(esc((placed? placed+' order(s) placed. ' : '')+failed.map(f=>f.item.name+': '+f.msg).join(' | ')));
            return;
          }
          route = "myorders"; renderSidebar(); renderPage(); toast("Order placed successfully!");
        },

        addInventory:()=>openModal('<h3>Add Inventory</h3><div class="field"><label>Name</label><input id="miName"></div><div class="formrow"><div class="field"><label>Category</label><select id="miCat"><option>Feed</option><option>Fertilizer</option><option>Seedlings</option><option>Veterinary</option><option>Other</option></select></div><div class="field"><label>Unit</label><input id="miUnit" value="bags"></div></div><div class="formrow"><div class="field"><label>Qty</label><input id="miQty" type="number" min="0" value="0"></div><div class="field"><label>Alert when stock is at or below</label><input id="miReorder" type="number" min="0" value="5"></div></div><div class="err hidden" id="miErr"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm primary" data-action="saveInventory">Save</button></div>'),
        saveInventory:async ()=>{
          var name=document.getElementById("miName").value.trim(), qty=parseFloat(document.getElementById("miQty").value), reorder=parseFloat(document.getElementById("miReorder").value), err=document.getElementById("miErr");
          if(!name||qty<0||isNaN(qty)||isNaN(reorder)||reorder<0){ err.textContent="Invalid fields."; err.classList.remove("hidden"); return; }
          await apiAction('addInventory', {id:uid("iv"),name:name,category:document.getElementById("miCat").value,unit:document.getElementById("miUnit").value||'units',qty:qty,reorderLevel:reorder,dateAdded:todayISO()}); closeModal(); renderPage(); toast("Inventory added.");
        },
        stockTx:()=>openModal('<h3>Stock In/Out</h3><div class="field"><label>Item</label><select id="msItem">'+state.inventory.map(i=>'<option value="'+i.id+'">'+esc(i.name)+' ('+i.qty+' '+i.unit+')</option>').join('')+'</select></div><div class="formrow"><div class="field"><label>Direction</label><select id="msDir"><option value="in">Stock In</option><option value="out">Stock Out</option></select></div><div class="field"><label>Quantity</label><input id="msQty" type="number" min="1" value="1"></div></div><div class="err hidden" id="msErr"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm primary" data-action="saveStockTx">Save</button></div>'),
        saveStockTx:async ()=>{
          var sid=document.getElementById("msItem").value, dir=document.getElementById("msDir").value, qty=parseFloat(document.getElementById("msQty").value);
          var item = state.inventory.find(i=>i.id===sid);
          if(!qty || qty<=0){ document.getElementById("msErr").textContent="Enter positive quantity."; document.getElementById("msErr").classList.remove("hidden"); return; }
          if(dir==='out' && qty>item.qty){ document.getElementById("msErr").textContent="Insufficient inventory."; document.getElementById("msErr").classList.remove("hidden"); return; }
          await apiAction('stockTx', {id:sid, amount: dir==='in'?qty:-qty}); closeModal(); renderPage(); toast("Stock updated.");
        },
        addExpense:()=>openModal('<h3>Record Expense</h3><div class="formrow"><div class="field"><label>Category</label><select id="meCat"><option>Feed</option><option>Fertilizer</option><option>Veterinary</option><option>Labor</option></select></div><div class="field"><label>Amount</label><input id="meAmount" type="number" min="1"></div></div><div class="field"><label>Description</label><input id="meDesc"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm primary" data-action="saveExpense">Save</button></div>'),
        saveExpense:async ()=>{ await apiAction('addExpense', {id:uid("ex"),category:document.getElementById("meCat").value,description:document.getElementById("meDesc").value,amount:parseFloat(document.getElementById("meAmount").value),date:todayISO(),recordedBy:state.currentUser.id}); closeModal(); renderPage(); toast("Expense added."); },
        
        addUser:()=>openModal('<h3>Add User</h3><div class="formrow"><div class="field"><label>Name</label><input id="muName"></div><div class="field"><label>Role</label><select id="muRole"><option value="farmhand">Farmhand</option><option value="owner">Owner</option></select></div></div><div class="formrow"><div class="field"><label>Email</label><input id="muEmail" type="email"></div><div class="field"><label>Phone (09...)</label><input id="muPhone" placeholder="09XX XXX XXXX" maxlength="13"></div></div><div class="field pass-field"><label>Password</label><div class="pass-wrap"><input id="muPass" type="password"><button class="pass-toggle">Show</button></div></div><div class="err hidden" id="muErr"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm primary" data-action="saveUser">Save</button></div>'),
        saveUser:async ()=>{
            var name = document.getElementById("muName").value.trim(), email = document.getElementById("muEmail").value.trim(), phone = document.getElementById("muPhone").value.trim(), pass = document.getElementById("muPass").value;
            var err = document.getElementById("muErr"); err.classList.add('hidden');
            if(!name || !email || !pass) { err.textContent = "Please fill all required fields."; err.classList.remove('hidden'); return; }
            if(pass.length < 8) { err.textContent = "Password must be at least 8 characters."; err.classList.remove('hidden'); return; }
            if(!isValidPHPhone(phone)) { err.textContent = "Use a valid 11-digit number starting with 09."; err.classList.remove('hidden'); return; }
            await apiAction('addUser', {id:uid("u"),name:name,role:document.getElementById("muRole").value,email:email,phone:normalizePhone(phone),password:pass,status:"Active"}); closeModal(); renderPage(); toast("User added."); 
        },
        toggleUserStatus:async ()=>{ await apiAction('toggleUserStatus',{id}); renderPage(); toast("Status updated."); },
        deleteUser: () => { customConfirm("Delete User", "Permanently delete this user? This action cannot be undone.", "danger", async () => { await apiAction('deleteUser', {id}); renderPage(); toast("User permanently deleted."); }); },
        saveProfile:async ()=>{ 
            var name = document.getElementById("pfName").value.trim(), phone = document.getElementById("pfPhone").value.trim(), err = document.getElementById("pfErr");
            err.classList.add('hidden');
            if(!name) { err.textContent="Name cannot be empty."; err.classList.remove('hidden'); return; }
            if(!isValidPHPhone(phone)) { err.textContent="Use a valid 11-digit number starting with 09."; err.classList.remove('hidden'); return; }
            await apiAction('updateProfile',{id:state.currentUser.id, name:name, phone:normalizePhone(phone)}); renderPage(); renderSidebar(); toast("Profile updated."); 
        },

        addProductModal:()=>openModal('<h3>Add Product</h3><div class="field"><label>Product Name</label><input id="mpName" placeholder="e.g. Fresh Brown Eggs"></div><div class="formrow"><div class="field"><label>Category</label><select id="mpCat"><option>Eggs</option><option>Livestock</option><option>Fresh Produce</option></select></div><div class="field"><label>Unit</label><input id="mpUnit" value="tray"></div></div><div class="formrow"><div class="field"><label>Price (₱)</label><input id="mpPrice" type="number" min="1"></div><div class="field"><label>Qty</label><input id="mpQty" type="number" min="0" value="0"></div></div><div class="field"><label>Upload Image</label><input type="file" id="mpImageFile" accept="image/*" style="padding: 10px; background: var(--bg); border: 2px dashed var(--line); border-radius: 10px"></div><div class="err hidden" id="mpErr"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm primary" data-action="saveNewProduct">Save Product</button></div>'),
        saveNewProduct:async ()=>{
          var name=document.getElementById("mpName").value.trim(), cat=document.getElementById("mpCat").value, unit=document.getElementById("mpUnit").value.trim(), price=parseFloat(document.getElementById("mpPrice").value), qty=parseFloat(document.getElementById("mpQty").value);
          var fileInput = document.getElementById("mpImageFile");
          var err = document.getElementById("mpErr");
          
          if(!name||!unit||isNaN(price)||isNaN(qty)){ err.textContent="Invalid fields."; err.classList.remove("hidden"); return; }
          
          var imagePath = "";
          if (fileInput.files.length > 0) {
            try { 
              document.body.style.cursor = 'wait';
              imagePath = await uploadFile(fileInput.files[0]); 
            } catch(e) { 
              document.body.style.cursor = 'default';
              err.textContent="Image upload failed."; err.classList.remove("hidden"); return; 
            }
          }
          
          document.body.style.cursor = 'default';
          await apiAction('addProduct', {id:uid("pd"), name:name, category:cat, unit:unit, price:price, qty:qty, image:imagePath}); 
          closeModal(); renderPage(); toast("Product listed for sale.");
        },
        
        editProductModal:()=>{
          var p = state.products.find(x=>x.id===id);
          openModal('<h3>Edit Product</h3><div class="field"><label>Product Name</label><input id="mpName" value="'+esc(p.name)+'"></div><div class="formrow"><div class="field"><label>Category</label><select id="mpCat"><option '+(p.category==='Eggs'?'selected':'')+'>Eggs</option><option '+(p.category==='Livestock'?'selected':'')+'>Livestock</option><option '+(p.category==='Fresh Produce'?'selected':'')+'>Fresh Produce</option></select></div><div class="field"><label>Unit</label><input id="mpUnit" value="'+esc(p.unit)+'"></div></div><div class="formrow"><div class="field"><label>Price (₱)</label><input id="mpPrice" type="number" min="1" value="'+p.price+'"></div><div class="field"><label>Available Qty</label><input id="mpQty" type="number" min="0" value="'+p.qty+'"></div></div><div class="field"><label>Upload New Image (Optional)</label><input type="file" id="mpImageFile" accept="image/*" style="padding: 10px; background: var(--bg); border: 2px dashed var(--line); border-radius: 10px"><input type="hidden" id="mpImagePath" value="'+esc(p.image||'')+'"></div><div class="err hidden" id="mpErr"></div><div class="modal-actions"><button class="btn-sm" data-action="closeModal">Cancel</button><button class="btn-sm primary" data-action="saveEditProduct" data-id="'+id+'">Update Product</button></div>');
        },
        saveEditProduct:async ()=>{
          var name=document.getElementById("mpName").value.trim(), cat=document.getElementById("mpCat").value, unit=document.getElementById("mpUnit").value.trim(), price=parseFloat(document.getElementById("mpPrice").value), qty=parseFloat(document.getElementById("mpQty").value);
          var fileInput = document.getElementById("mpImageFile");
          var imagePath = document.getElementById("mpImagePath").value;
          var err = document.getElementById("mpErr");
          
          if(!name||!unit||isNaN(price)||isNaN(qty)){ err.textContent="Invalid fields."; err.classList.remove("hidden"); return; }
          
          if (fileInput.files.length > 0) {
            try { 
              document.body.style.cursor = 'wait';
              imagePath = await uploadFile(fileInput.files[0]); 
            } catch(e) { 
              document.body.style.cursor = 'default';
              err.textContent="Image upload failed."; err.classList.remove("hidden"); return; 
            }
          }
          
          document.body.style.cursor = 'default';
          await apiAction('updateProduct', {id:id, name:name, category:cat, unit:unit, price:price, qty:qty, image:imagePath}); 
          closeModal(); renderPage(); toast("Product updated.");
        },
        deleteProduct: () => { customConfirm("Remove Product", "Remove product from marketplace?", "danger", async () => { await apiAction('deleteProduct', {id}); renderPage(); toast("Removed."); }); },
        confirmOrder:async ()=>{ await apiAction('updateOrderStatus', {id, status:"Confirmed"}); renderPage(); toast("Confirmed."); },
        rejectOrder:async ()=>{ await apiAction('updateOrderStatus', {id, status:"Rejected"}); renderPage(); toast("Rejected."); },
        completeOrder:async ()=>{ await apiAction('updateOrderStatus', {id, status:"Completed"}); renderPage(); toast("Completed."); },
        cancelOrder: () => { customConfirm("Cancel Order", "Are you sure you want to cancel this order?", "danger", async () => { await apiAction('cancelOrder', {id}); renderPage(); toast("Order Cancelled."); }); },
        markAllRead:async ()=>{ await apiAction('markAllRead', {userId:state.currentUser.id}); renderPage(); },
        goProducts:()=>{route="dashboard";renderPage();renderSidebar();}, goReports:()=>{route="reports";renderPage();renderSidebar();},
        clearReportFilter:()=>{ reportFilter={from:'',to:''}; renderPage(); },
        closeModal: closeModal
      };
      if(fns[a]) fns[a]();
    };
  });
}

function applyFilters(){
  var ls=document.getElementById("lvSearch")?.value.toLowerCase(), lt=document.getElementById("lvTypeFilter")?.value;
  document.querySelectorAll("#lvTable tr[data-tag]").forEach(r=>r.style.display=(!ls||r.getAttribute("data-tag").indexOf(ls)>-1)&&(!lt||r.getAttribute("data-type")===lt)?'':'none');
  var ts=document.getElementById("taskFilter")?.value;
  document.querySelectorAll("#taskListWrap .card").forEach(c=>c.style.display=(!ts||c.getAttribute("data-status")===ts)?'':'none');
}

document.addEventListener('click', function(e) {
  if (e.target && e.target.classList.contains('pass-toggle')) {
    e.preventDefault();
    let input = e.target.previousElementSibling;
    if (input && input.tagName === 'INPUT') {
      let isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      e.target.textContent = isPass ? 'Hide' : 'Show';
    }
  }
});

var loginRole="owner";
document.getElementById("loginRolePick").addEventListener("click",function(e){
  var b=e.target.closest("button"); if(!b) return;
  document.querySelectorAll("#loginRolePick button").forEach(x=>x.classList.remove("active"));
  b.classList.add("active"); loginRole=b.getAttribute("data-role");
});
function showAuth(view){
  document.getElementById("authWrap").classList.remove("hidden");
  document.getElementById("loginView").classList.toggle("hidden",view!=='login');
  document.getElementById("registerView").classList.toggle("hidden",view!=='register');
}
document.getElementById("landLoginBtn").onclick=()=>showAuth('login');
document.getElementById("heroLoginBtn").onclick=()=>showAuth('login');
document.getElementById("heroRegisterBtn").onclick=()=>showAuth('register');
document.getElementById("authClose").onclick=()=>document.getElementById("authWrap").classList.add("hidden");
document.getElementById("toRegister").onclick=()=>showAuth('register');
document.getElementById("toLogin").onclick=()=>showAuth('login');

document.getElementById("loginSubmit").onclick=async ()=>{
  var email=document.getElementById("loginEmail").value.trim(), pass=document.getElementById("loginPass").value, err=document.getElementById("loginErr");
  err.className="err hidden";
  if(!email||!pass) return err.textContent="Enter email and password.", err.classList.remove("hidden");

  var r;
  try { r = await postJSON('/api/login', {email:email, password:pass, role:loginRole}); }
  catch(e) { return err.textContent="Cannot reach the server. Check your connection.", err.classList.remove("hidden"); }
  if(!r.ok) return err.textContent=(r.data&&r.data.error)||"Login failed.", err.classList.remove("hidden");

  authToken = r.data.token;
  state.currentUser = r.data.user;
  await reloadState();
  document.getElementById("loginPass").value = "";
  enterApp();
};

document.getElementById("regSubmit").onclick=async ()=>{
  var name=document.getElementById("regName").value.trim(), email=document.getElementById("regEmail").value.trim(), phone=document.getElementById("regPhone").value.trim(), pass=document.getElementById("regPass").value;
  var err = document.getElementById("regErr"); err.classList.add("hidden");
  if(!name||!email||!phone||!pass) { err.textContent = "All fields required."; err.classList.remove("hidden"); return; }
  if(pass.length < 8) { err.textContent = "Password must be at least 8 characters."; err.classList.remove("hidden"); return; }
  if(!isValidPHPhone(phone)) { err.textContent = "Use a valid 11-digit number starting with 09."; err.classList.remove('hidden'); return; }
  if(!isValidEmail(email)) { err.textContent = "Invalid email."; err.classList.remove('hidden'); return; }
  var r;
  try { r = await postJSON('/api/register', {name:name, email:email, phone:normalizePhone(phone), password:pass}); }
  catch(e) { err.textContent = "Cannot reach the server. Check your connection."; err.classList.remove('hidden'); return; }
  if(!r.ok) { err.textContent = (r.data&&r.data.error)||"Registration failed."; err.classList.remove('hidden'); return; }
  authToken = r.data.token;
  state.currentUser = r.data.user;
  await reloadState();
  document.getElementById("regPass").value = "";
  toast("Account created. Welcome!");
  enterApp();
};

function enterApp(){
  document.getElementById("authWrap").classList.add("hidden");
  document.getElementById("landing").style.display="none";
  document.getElementById("app").style.display="block";
  route = "dashboard"; renderSidebar(); renderPage();
}
function doLogout(){
  authToken=null; cart=[]; state={currentUser:null};
  closeModal();
  document.getElementById("loginPass").value="";
  document.getElementById("app").style.display="none";
  document.getElementById("landing").style.display="flex";
}
document.getElementById("logoutBtn").onclick=doLogout;

(async function init(){
  await reloadState();            // no token yet: only applies the saved theme
  if(state.currentUser) enterApp();
})();

// Register the service worker so HarvTrack is installable and its pages work offline
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('/sw.js').catch(function(e){ console.warn('Service worker registration failed', e); });
  });
}
})();