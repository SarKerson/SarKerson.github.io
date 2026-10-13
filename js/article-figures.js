/* Every figure remains a direct image link when scripting is unavailable. */
(() => {
  const links = [...document.querySelectorAll('.research-figure .figure-open')];
  if (!links.length || typeof HTMLDialogElement === 'undefined') return;
  const dialog = document.createElement('dialog');
  dialog.className = 'figure-dialog';
  dialog.setAttribute('aria-label', '配图阅读器');
  dialog.innerHTML = '<div class="figure-toolbar"><span class="figure-dialog-title"></span><div class="figure-actions"><button type="button" data-action="zoom">原始尺寸</button><a target="_blank" rel="noopener">打开原图</a><button type="button" data-action="close" aria-label="关闭配图">关闭 ×</button></div></div><div class="figure-viewport"><img alt=""></div>';
  document.body.append(dialog);
  const view = dialog.querySelector('.figure-viewport');
  const image = view.querySelector('img');
  const zoom = dialog.querySelector('[data-action="zoom"]');
  let opener;
  links.forEach(link => link.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); opener = link;
    image.src = link.href; image.alt = link.querySelector('img').alt;
    dialog.querySelector('.figure-dialog-title').textContent = image.alt;
    dialog.querySelector('.figure-actions a').href = link.href;
    view.classList.remove('at-original-size'); zoom.textContent = '原始尺寸';
    dialog.showModal(); document.body.classList.add('figure-is-open');
  }));
  zoom.addEventListener('click', () => {
    const original = view.classList.toggle('at-original-size');
    zoom.textContent = original ? '适应屏幕' : '原始尺寸'; view.scrollTo(0, 0);
  });
  dialog.querySelector('[data-action="close"]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { document.body.classList.remove('figure-is-open'); if (opener) opener.focus(); });
})();
