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
        window.addEventListener('message', function(e) {
            var d = e.data;
            if (d && d.type === 'instrument-ready' && d.name) {
                instName = d.name;
            }
        });
        // Also send messages from popout windows back to parent via BroadcastChannel
        if (window.opener && window === window.parent) {
            window._studioBroadcast = bc;
            window._sendToParent = function(msg) {
                msg._from = instName || 'unknown';
                bc.postMessage(msg);
            };
        }

        // Forward keyboard events to parent so QWERTY MIDI works from any iframe
        if (window !== window.parent) {
            document.addEventListener('keydown', function(e) {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                window.parent.postMessage({
                    type: 'iframe-key', event: 'keydown',
                    key: e.key, code: e.code, repeat: e.repeat,
                    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey
                }, '*');
            }, true);
            document.addEventListener('keyup', function(e) {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                window.parent.postMessage({
                    type: 'iframe-key', event: 'keyup',
                    key: e.key, code: e.code,
                    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey
                }, '*');
            }, true);
        }
    } catch(ex) {}
})();
