// Talks to the GloryCast Cam server: a live event stream in, small posts out.
(function () {
  "use strict";
  var ICE = [{ urls: "stun:stun.l.google.com:19302" }]; // only helps when there is internet; the Wi-Fi path is used first

  function connect(params, handlers) {
    var q = Object.keys(params).map(function (k) { return k + "=" + encodeURIComponent(params[k]); }).join("&");
    var me = { id: null, es: null, closed: false };
    function open() {
      var es = me.es = new EventSource("/events?" + q);
      Object.keys(handlers).forEach(function (ev) {
        es.addEventListener(ev, function (e) {
          var data = {}; try { data = JSON.parse(e.data); } catch (x) { /* ignore */ }
          if (ev === "hello") me.id = data.id;
          handlers[ev](data);
        });
      });
      es.onerror = function () { if (handlers.down) handlers.down(); };
      es.onopen = function () { if (handlers.up) handlers.up(); };
    }
    open();
    me.post = function (path, data) {
      data = Object.assign({ id: me.id, from: me.id }, data);
      return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
        .then(function (r) { return r.json(); }).catch(function () { return {}; });
    };
    me.signal = function (to, data) { return me.post("/signal", { to: to, data: data }); };
    me.close = function () { me.closed = true; if (me.es) me.es.close(); };
    return me;
  }

  window.GCSignal = { connect: connect, ICE: ICE };
})();
