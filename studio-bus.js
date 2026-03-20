// Studio BroadcastChannel bridge — enables communication when instruments are popped out
(function() {
    if (window === window.parent && window.opener === null) return; // standalone, not iframe or popup
    try {
        var instName = null;
        var bc = new BroadcastChannel('studio-bus');
        bc.onmessage = function(e) {
            var d = e.data;
            if (!d || !d._target) return;
            // Only process messages targeted at this instrument
            if (d._target === instName) {
                window.dispatchEvent(new MessageEvent('message', {data: d}));
            }
        };
        // Intercept instrument-ready to learn our name, and relay messages back via broadcast
        var origPostMessage = window.parent.postMessage.bind(window.parent);
        var _origAddEventListener = window.addEventListener;
        window.addEventListener('message', function(e) {
            var d = e.data;
            if (d && d.type === 'instrument-ready' && d.name) {
                instName = d.name;
            }
        });
        // Also send messages from popout windows back to parent via BroadcastChannel
        if (window.opener && window === window.parent) {
            var origParentPost = null; // no parent iframe
            window._studioBroadcast = bc;
            window._sendToParent = function(msg) {
                msg._from = instName || 'unknown';
                bc.postMessage(msg);
            };
        }
    } catch(ex) {}
})();
