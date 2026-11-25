const reveal = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      reveal.unobserve(e.target);
    }
  },
  { threshold: 0, rootMargin: "0px 0px 80px 0px" },
);
for (const el of document.querySelectorAll("[data-reveal]")) {
  if (el.getBoundingClientRect().bottom <= 0) el.classList.add("in");
  else reveal.observe(el);
}
