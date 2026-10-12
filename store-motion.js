/* Subtle, optional motion. Content remains visible without JavaScript. */
document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('professional-store');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches) return;
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.animate([{opacity:.55,transform:'translateY(18px)'},{opacity:1,transform:'translateY(0)'}],{duration:550,easing:'cubic-bezier(.2,.7,.2,1)'});
      observer.unobserve(entry.target);
    });
  }, {threshold:.08});
  document.querySelectorAll('.section-header,.parts-dir,.brands-logo-grid,.product-section-card').forEach(el => observer.observe(el));
});
