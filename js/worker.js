/* Runs the tracer off the main thread so the page stays responsive. */
importScripts('tracer.js');

self.onmessage = function (e) {
  var msg = e.data;
  try {
    var img = { data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height };
    var lastPost = 0;
    var result = self.Vectorious.vectorize(img, msg.options, function (stage, fraction) {
      var t = Date.now();
      if (t - lastPost > 60 || fraction === 0) {
        lastPost = t;
        self.postMessage({ id: msg.id, type: 'progress', stage: stage, fraction: fraction });
      }
    });
    self.postMessage({ id: msg.id, type: 'done', svg: result.svg, palette: result.palette, stats: result.stats });
  } catch (err) {
    self.postMessage({ id: msg.id, type: 'error', message: String(err && err.message || err) });
  }
};
