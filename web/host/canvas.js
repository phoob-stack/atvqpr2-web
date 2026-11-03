// Loaded by index.html after the canvas (a classic script, at the end of <body>).
// Keep the canvas backing store at the element's size (letterboxing is in present.js).
{
  const cv = document.getElementById('screen');
  new ResizeObserver(() => { cv.width = Math.max(1, Math.round(cv.clientWidth * devicePixelRatio));
    cv.height = Math.max(1, Math.round(cv.clientHeight * devicePixelRatio)); }).observe(cv);
  addEventListener('keydown', (e) => { if (e.code === 'F2') document.body.classList.toggle('nolog'); });
}
