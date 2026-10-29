/* Claudock site: Copy for the install commands, direct installer links, launch film controls. No dependencies. */
(function () {
  'use strict'

  var REPO = 'behkha/claudock'
  var FALLBACK = 'https://github.com/' + REPO + '/releases/latest'
  var API = 'https://api.github.com/repos/' + REPO + '/releases/latest'

  // Which release file goes with which download link. Names follow electron-builder's output, e.g.
  // Claudock-0.1.0-arm64.dmg, Claudock-0.1.0-x64.dmg, Claudock-Setup-0.1.0.exe,
  // Claudock-0.1.0-x86_64.AppImage, Claudock-0.1.0-amd64.deb (the arm64 Linux files are skipped).
  function pickAssets(assets) {
    var out = { mac: '', macIntel: '', win: '', linux: '', deb: '' }
    var isArm = function (n) { return /arm64|aarch64/i.test(n) }
    ;(assets || []).forEach(function (a) {
      var n = a && a.name, u = a && a.browser_download_url
      if (!n || !u) return
      if (/-arm64\.dmg$/i.test(n)) out.mac = out.mac || u
      else if (/-x64\.dmg$/i.test(n)) out.macIntel = out.macIntel || u
      else if (/\.exe$/i.test(n)) out.win = out.win || u
      else if (/\.AppImage$/i.test(n) && !isArm(n)) out.linux = out.linux || u
      else if (/\.deb$/i.test(n) && !isArm(n)) out.deb = out.deb || u
    })
    return out
  }

  // Each installer link names its file in pickAssets() with data-asset; until the release answers, it opens the releases page
  function render(urls) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-asset]'), function (a) {
      a.href = urls[a.getAttribute('data-asset')] || FALLBACK
    })
  }

  function cached() {
    try {
      var c = JSON.parse(sessionStorage.getItem('claudock-release') || 'null')
      if (c && Date.now() - c.t < 10 * 60 * 1000) return c.urls
    } catch { /* storage blocked */ }
    return null
  }

  function remember(urls) {
    try { sessionStorage.setItem('claudock-release', JSON.stringify({ t: Date.now(), urls: urls })) } catch { /* ignore */ }
  }

  function downloads() {
    if (!document.querySelector('[data-asset]')) return // only the home page has the installer links
    var hit = cached()
    if (hit) return render(hit)
    if (typeof fetch !== 'function') return
    fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(function (release) {
        var urls = pickAssets(release.assets)
        remember(urls)
        render(urls)
      })
      .catch(function () { /* keep the releases-page links */ })
  }

  function video() {
    var v = document.getElementById('demo')
    var btn = document.getElementById('toggle')
    var sound = document.getElementById('sound')
    if (!v || !btn) return
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    var userPaused = reduce.matches
    var visible = true

    function sync() { btn.dataset.playing = String(!v.paused); btn.setAttribute('aria-label', v.paused ? 'Play film' : 'Pause film') }
    function play() { var p = v.play(); if (p && p.catch) p.catch(function () { /* autoplay blocked: poster stays */ }) }

    // the dark film's poster; the source itself is picked by the <source media> attributes
    if (v.dataset.posterDark && window.matchMedia('(prefers-color-scheme: dark)').matches) v.poster = v.dataset.posterDark
    v.controls = false
    btn.hidden = false
    v.addEventListener('play', sync)
    v.addEventListener('pause', sync)
    btn.addEventListener('click', function () {
      if (v.paused) { userPaused = false; play() } else { userPaused = true; v.pause() }
    })
    v.addEventListener('click', function () { btn.click() })

    // The film starts muted (browsers only autoplay it that way); the score comes on from this button
    if (sound) {
      sound.hidden = false
      sound.addEventListener('click', function () {
        v.muted = !v.muted
        sound.setAttribute('aria-pressed', String(!v.muted))
        sound.setAttribute('aria-label', v.muted ? 'Turn sound on' : 'Turn sound off')
        if (!v.muted && v.paused) { userPaused = false; play() }
      })
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting
        if (!visible) v.pause()
        else if (!userPaused && !reduce.matches) play()
      }, { threshold: 0.25 }).observe(v)
    }
    var onReduce = function () { if (reduce.matches) { userPaused = true; v.pause() } }
    if (reduce.addEventListener) reduce.addEventListener('change', onReduce)

    sync()
  }

  // A Copy button for a block of commands, without the prompt in its <b>. Without clipboard access the button stays
  // hidden and the text stays selectable.
  function copy(btn, code) {
    if (!btn || !code || !navigator.clipboard) return
    btn.hidden = false
    var timer
    btn.addEventListener('click', function () {
      var prompt = code.querySelector('b')
      var text = code.textContent.slice(prompt ? prompt.textContent.length : 0).trim()
      navigator.clipboard.writeText(text + '\n').then(function () {
        btn.textContent = 'Copied'
        clearTimeout(timer)
        timer = setTimeout(function () { btn.textContent = 'Copy' }, 1600)
      }, function () { /* clipboard refused: the text stays selectable */ })
    })
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { pickAssets: pickAssets }
  if (typeof document === 'undefined') return
  downloads()
  video()
  copy(document.getElementById('npx-copy'), document.getElementById('npx-cmd'))
  copy(document.getElementById('copy'), document.getElementById('cmds'))
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (b) {
    copy(b, document.getElementById(b.getAttribute('data-copy')))
  })
})()
