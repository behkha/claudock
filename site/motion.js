/* Claudock site: scroll scenes (GSAP 3.13 from cdnjs). The page reads fine without this file or GSAP:
 * index.html adds .motion to <html> before first paint, and this file removes it again when GSAP is missing. */
(function () {
  'use strict'

  var root = document.documentElement
  var gsap = window.gsap
  if (!root.classList.contains('motion')) return
  if (!gsap || !window.ScrollTrigger || !window.SplitText || !window.MorphSVGPlugin || !window.DrawSVGPlugin) {
    root.classList.remove('motion')
    return
  }
  gsap.registerPlugin(window.ScrollTrigger, window.SplitText, window.MorphSVGPlugin, window.DrawSVGPlugin)
  var ScrollTrigger = window.ScrollTrigger
  var SplitText = window.SplitText

  function $(s) { return document.querySelector(s) }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)) }

  // Each file in the listing lands on the sidebar label it becomes: [file, label, label's vertical centre in the
  // 1600x900 screenshots]. New screenshots with a different sidebar need new numbers here. Plans and History sit
  // below the 16:9 window's edge, so their files aren't listed.
  var FILES = [
    ['settings.json', 'Settings', 0.2323], ['CLAUDE.md', 'CLAUDE.md & rules', 0.2788], ['hooks/', 'Hooks', 0.3247],
    ['skills/', 'Skills', 0.5135], ['agents/', 'Agents', 0.5594], ['commands/', 'Commands', 0.6052],
    ['plugins/', 'Plugins', 0.6503], ['dev-mods/', 'Mods', 0.6969], ['projects/', 'Projects', 0.8851]
  ]
  var LABEL_X = 58 / 1600 // labels' left edge
  var LABEL_FS = 18 / 1600 // labels' font size
  var ZOOM = 1.3 // the camera starts at 1.3x on the sidebar, showing y 0.18 to 0.95 of the screenshot
  var ZOOM_Y = 0.18

  // Safe by design: camera (snapshot), document (atomic write), trash, lock, all in a 100x100 box
  var ICONS = [
    'M18 30 H36 L42 20 H58 L64 30 H82 Q90 30 90 38 V74 Q90 82 82 82 H18 Q10 82 10 74 V38 Q10 30 18 30 Z',
    'M26 12 H60 L78 30 V84 Q78 90 72 90 H26 Q20 90 20 84 V18 Q20 12 26 12 Z',
    'M38 12 H62 V19 H82 V28 H18 V19 H38 Z M24 33 H76 L71 85 Q70 90 65 90 H35 Q30 90 29 85 Z',
    'M30 44 V32 Q30 12 50 12 Q70 12 70 32 V44 H61 V32 Q61 21 50 21 Q39 21 39 32 V44 Z M24 44 H76 Q82 44 82 50 V82 Q82 88 76 88 H24 Q18 88 18 82 V50 Q18 44 24 44 Z'
  ]

  var NAMES = ['settings.json', 'CLAUDE.md', 'hooks/', 'skills/', 'agents/', 'commands/', 'plugins/', '.mcp.json', 'projects/', 'history.jsonl', 'plans/', 'rules/']

  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text) e.textContent = text
    return e
  }

  $('#lines').append.apply($('#lines'), FILES.map(function (f) {
    var line = el('div', 'line')
    line.append(el('span', 'fn' + (/\/$/.test(f[0]) ? ' dir' : ''), f[0]), el('span', 'lb', f[1]))
    return line
  }))
  // the commands, one span per line; the newlines stay as text so Copy gets the same text
  var code = $('#cmds code')
  var rows = code.textContent.split('\n')
  code.textContent = ''
  rows.forEach(function (r, i) {
    if (i) code.append('\n')
    code.append(el('span', 'cl', r))
  })
  ;[['#track-1', NAMES], ['#track-2', NAMES.slice().reverse()]].forEach(function (t) {
    var track = $(t[0])
    for (var i = 0; i < 3; i++) t[1].forEach(function (n) { track.append(el('span', '', n)) })
  })

  /* ---------------------------------------------------------------- header mark: the tilde draws itself */
  function mark() {
    gsap.timeline({ delay: 0.15 })
      .fromTo('.mark-wave', { drawSVG: '0%' }, { drawSVG: '100%', duration: 1.1, ease: 'power2.inOut' })
      .from('.mark-bar', { scaleY: 0, transformOrigin: '50% 100%', duration: 0.45, ease: 'back.out(2)' }, '-=0.25')
      .to('.mark-bar', { opacity: 0.25, repeat: 5, yoyo: true, duration: 0.35, ease: 'steps(1)' })
  }

  /* ---------------------------------------------------------------- hero: the listing becomes the app */
  function hero() {
    var win = $('#win')
    var W = win.clientWidth
    var H = win.clientHeight
    var lines = $$('.line')
    var cam = $('#cam')
    var screens = $$('.screen')
    var caps = $$('.cap')
    var fs = Math.max(9, W * LABEL_FS * ZOOM)
    var start = function (i) { return { x: W * 0.06, y: H * (0.22 + i * 0.058) } }
    var end = function (i) { return { x: W * LABEL_X * ZOOM, y: (FILES[i][2] - ZOOM_Y) * ZOOM * H } }

    $('#prompt').style.fontSize = fs + 'px'
    lines.forEach(function (line, i) {
      line.querySelector('.fn').style.fontSize = fs + 'px'
      line.querySelector('.lb').style.fontSize = fs + 'px'
      gsap.set(line, start(i))
    })
    gsap.set(cam, { scale: ZOOM, y: -ZOOM_Y * ZOOM * H, opacity: 0 })
    gsap.set(screens.slice(1), { clipPath: 'circle(0% at 18% 30%)' })
    gsap.set(caps, { autoAlpha: 0 })

    // on load: the headline rises word by word, the command types, the listing pours in
    var words = new SplitText('.hero h1 .ln', { type: 'words', mask: 'words' }).words
    var intro = gsap.timeline({ defaults: { ease: 'power3.out' } })
      .from(words, { yPercent: 110, duration: 0.9, stagger: 0.06 })
      .from('.get', { y: 16, autoAlpha: 0, duration: 0.6 }, '-=0.5')
      .from(win, { y: 40, rotationX: 8, transformPerspective: 1200, autoAlpha: 0, duration: 1 }, 0.15)
      .fromTo('#prompt .cmd', { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.5, ease: 'steps(12)' }, 0.7)
      .from(lines, { autoAlpha: 0, x: '-=12', duration: 0.35, stagger: 0.05 }, 1.2)
    gsap.to('.caret', { opacity: 0, repeat: -1, yoyo: true, duration: 0.5, ease: 'steps(1)' })

    // on scroll: files fly onto the sidebar, the terminal gives way to the app, the camera pulls back, the screens change
    var short = innerWidth < 700
    // A scroll that starts while the opening still pours the listing in (an Install link, say) ends the opening first, so
    // the scroll scene takes the lines from their resting place and they don't stay over the app
    var tl = gsap.timeline({
      scrollTrigger: {
        trigger: '#hero', start: short ? 'top 64px' : 'top top', end: function () { return '+=' + innerHeight * (short ? 3.8 : 5) }, pin: true, scrub: 0.8,
        onUpdate: function () { if (intro.progress() < 1) intro.progress(1) }
      }
    })
    tl.to('.hero-intro', { autoAlpha: 0, y: -40, duration: 0.5 }, 0)
      .to('#prompt', { autoAlpha: 0, duration: 0.3 }, 0.1)
    lines.forEach(function (line, i) {
      var s = start(i)
      var e = end(i)
      tl.to(line, { duration: 1, ease: 'power2.inOut', keyframes: { x: [s.x, s.x + W * 0.04, e.x], y: [s.y, s.y, e.y], easeEach: 'sine.inOut' } }, 0.15 + i * 0.05)
        .to(line.querySelector('.fn'), { autoAlpha: 0, duration: 0.25 }, 0.85 + i * 0.05)
        .to(line.querySelector('.lb'), { autoAlpha: 1, duration: 0.25 }, 0.85 + i * 0.05)
    })
    var cap = function (i, show) {
      return show
        ? gsap.fromTo(caps[i], { autoAlpha: 0, yPercent: -10 }, { autoAlpha: 1, yPercent: -50, duration: 0.4, ease: 'power2.out', immediateRender: false })
        : gsap.to(caps[i], { autoAlpha: 0, yPercent: -90, duration: 0.3, ease: 'power2.in' })
    }
    tl.to('.term', { autoAlpha: 0, duration: 0.6 }, 0.9)
      .to(cam, { opacity: 1, duration: 0.4 }, 1.7)
      .to(lines, { autoAlpha: 0, duration: 0.2 }, 2.0)
      .to(cam, { scale: 1, y: 0, duration: 1, ease: 'power2.inOut' }, 2.2)
      .add(cap(0, true), 2.6)
    for (var i = 1; i < screens.length; i++) {
      var at = 3.4 + (i - 1) * 1.1
      tl.add(cap(i - 1, false), at)
        .to(screens[i], { clipPath: 'circle(150% at 18% 30%)', duration: 0.9, ease: 'power2.inOut' }, at)
        .add(cap(i, true), at + 0.35)
    }
    tl.to({}, { duration: 0.5 })
  }

  /* ---------------------------------------------------------------- file names: drift, faster and leaning with scroll */
  function marquee() {
    var t1 = $('#track-1')
    var t2 = $('#track-2')
    var loops = [
      gsap.to(t1, { xPercent: -100 / 3, repeat: -1, duration: 34, ease: 'none' }),
      gsap.fromTo(t2, { xPercent: -100 / 3 }, { xPercent: 0, repeat: -1, duration: 34, ease: 'none' })
    ]
    var skew = gsap.quickTo([t1, t2], 'skewX', { duration: 0.4, ease: 'power3' })
    var settle
    ScrollTrigger.create({
      trigger: '.marquee', start: 'top bottom', end: 'bottom top',
      onUpdate: function (self) {
        var v = self.getVelocity()
        var dir = v < 0 ? -1 : 1
        gsap.to(loops, { timeScale: dir * (1 + Math.min(Math.abs(v) / 300, 6)), duration: 0.2, overwrite: true })
        gsap.to(loops, { timeScale: dir, duration: 1.2, delay: 0.2 })
        skew(gsap.utils.clamp(-10, 10, v / -120))
        clearTimeout(settle)
        settle = setTimeout(function () { skew(0) }, 150)
      }
    })
    gsap.from('.marquee', { autoAlpha: 0, y: 40, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: '.marquee', start: 'top 90%' } })
  }

  /* ---------------------------------------------------------------- the rest of the page */
  function sections() {
    gsap.from('.film', { y: 80, rotationX: 14, transformPerspective: 1400, transformOrigin: '50% 100%', scale: 0.94, ease: 'none', scrollTrigger: { trigger: '.film', start: 'top bottom', end: 'top 40%', scrub: 0.6 } })

    $$('.safe li').forEach(function (li, i) {
      gsap.from(li.children, { y: 26, autoAlpha: 0, duration: 0.7, stagger: 0.08, ease: 'power3.out', scrollTrigger: { trigger: li, start: 'top 80%' } })
      var morph = function (n) { gsap.to('#glyph', { morphSVG: ICONS[n], duration: 0.7, ease: 'expo.inOut', overwrite: true }) }
      ScrollTrigger.create({
        trigger: li, start: 'top 55%',
        onEnter: function () { morph(i) },
        onLeaveBack: function () { morph(Math.max(0, i - 1)) }
      })
    })
    gsap.to('.safe-icon .spark', { scale: 1.6, transformOrigin: '50% 50%', repeat: -1, yoyo: true, duration: 1.1, ease: 'sine.inOut' })

    $$('.safe h2, .try-head').forEach(function (h) {
      gsap.from(h, { y: 30, autoAlpha: 0, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: h, start: 'top 85%' } })
    })
    gsap.from('#cmds .cl', { clipPath: 'inset(0 100% 0 0)', duration: 0.6, stagger: 0.18, ease: 'steps(14)', scrollTrigger: { trigger: '.code', start: 'top 80%' } })
  }

  var ctx
  var lastW = innerWidth
  function build() {
    ctx = gsap.context(function () { hero(); marquee(); sections() })
    root.classList.add('motion-ready')
    ScrollTrigger.refresh()
  }
  function start() {
    mark()
    build()
    var timer
    addEventListener('resize', function () {
      if (Math.abs(innerWidth - lastW) < 40) return // phones resize on scroll as the address bar hides
      lastW = innerWidth
      clearTimeout(timer)
      timer = setTimeout(function () { ctx.revert(); build() }, 250)
    })
  }
  // The window's size comes from its aspect ratio, so the label positions are known before the screenshots load
  ;(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(start)
})()
