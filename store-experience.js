/* Shared storefront navigation and guidance, independent of catalogue data. */
document.addEventListener('DOMContentLoaded', () => {
  const page = location.pathname.split('/').pop() || 'index.html';
  document.body.classList.add('professional-store');
  document.querySelectorAll('.nav-link[href]').forEach(a => {
    if (a.getAttribute('href') === page) a.setAttribute('aria-current', 'page');
  });
  const top = document.createElement('button');
  top.className = 'back-to-top'; top.type = 'button';
  top.setAttribute('aria-label', 'العودة لأعلى الصفحة');
  top.innerHTML = '<i class="fa-solid fa-arrow-up" aria-hidden="true"></i>';
  top.hidden = true;
  top.addEventListener('click', () => window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));
  document.body.append(top);
  window.addEventListener('scroll', () => {top.hidden = window.scrollY < 650;}, {passive:true});
  if (!['index.html','contact.html'].includes(page)) {
    const footer = document.querySelector('.site-footer') || document.querySelector('footer');
    if (footer) {
      const section = document.createElement('section');
      section.className = 'container service-callout';
      section.innerHTML = '<div><span class="service-kicker">متخصصون في السيارات الصينية</span><h2>تحتاج مساعدة في اختيار القطعة؟</h2><p>أرسل رقم القطعة أو صورتها وبيانات السيارة. نساعدك في الاختيار أو البحث عن القطعة غير الموجودة.</p></div><a class="btn btn-primary" href="contact.html"><i class="fa-solid fa-headset" aria-hidden="true"></i> تحدث مع فريق المتجر</a>';
      footer.before(section);
    }
  }
});
