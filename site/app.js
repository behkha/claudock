/* Claudock site: OS-aware download button, demo video controls, copy button. No dependencies. */
(function () {
  'use strict'

  var REPO = 'behkha/claudock'
  var FALLBACK = 'https://github.com/' + REPO + '/releases/latest'
  var GITHUB = 'https://github.com/' + REPO
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

  function detectOS() {
    var nav = typeof navigator === 'undefined' ? {} : navigator
    var platform = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || ''
    var ua = nav.userAgent || ''
    if (/android|iphone|ipad|ipod|cros/i.test(ua)) return ''
    if (/mac/i.test(platform) || /mac os x/i.test(ua)) return nav.maxTouchPoints > 1 ? '' : 'mac' // iPadOS says "MacIntel"
    if (/win/i.test(platform) || /windows/i.test(ua)) return 'win'
    if (/linux|x11/i.test(platform) || /linux|x11/i.test(ua)) return 'linux'
    return ''
  }

  // key: field of pickAssets(); primary: button text; other: label in the row of other downloads
  var TARGETS = [
    { key: 'mac', os: 'mac', primary: 'Download for Mac', other: 'Mac Apple silicon' },
    { key: 'macIntel', os: '', primary: '', other: 'Mac Intel' },
    { key: 'win', os: 'win', primary: 'Download for Windows', other: 'Windows' },
    { key: 'linux', os: 'linux', primary: 'Download for Linux', other: 'Linux' },
    { key: 'deb', os: '', primary: '', other: 'Linux .deb' }
  ]

  function render(os, urls) {
    var button = document.getElementById('download')
    var label = document.getElementById('download-label')
    var others = document.getElementById('others')
    var note = document.getElementById('note')
    if (!button || !label || !others) return

    var primary = TARGETS.filter(function (t) { return t.os && t.os === os })[0]
    button.href = (primary && urls[primary.key]) || FALLBACK
    label.textContent = primary ? primary.primary : 'Download'
    if (note) note.hidden = !(os === 'mac' || os === 'win')

    others.textContent = ''
    TARGETS.forEach(function (t) {
      if (t === primary) return
      var a = document.createElement('a')
      a.href = urls[t.key] || FALLBACK
      a.textContent = t.other
      others.appendChild(a)
    })
    var gh = document.createElement('a')
    gh.href = GITHUB
    gh.textContent = 'GitHub'
    others.appendChild(gh)
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
    var os = detectOS()
    render(os, {}) // right away: OS-specific wording, every link on the releases page
    var hit = cached()
    if (hit) return render(os, hit)
    if (typeof fetch !== 'function') return
    fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then(function (release) {
        var urls = pickAssets(release.assets)
        remember(urls)
        render(os, urls)
      })
      .catch(function () { /* keep the releases-page links */ })
  }

  function video() {
    var v = document.getElementById('demo')
    var btn = document.getElementById('toggle')
    if (!v || !btn) return
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    var userPaused = reduce.matches
    var visible = true

    function sync() { btn.dataset.playing = String(!v.paused); btn.setAttribute('aria-label', v.paused ? 'Play demo' : 'Pause demo') }
    function play() { var p = v.play(); if (p && p.catch) p.catch(function () { /* autoplay blocked: poster stays */ }) }

    v.controls = false
    btn.hidden = false
    v.addEventListener('play', sync)
    v.addEventListener('pause', sync)
    btn.addEventListener('click', function () {
      if (v.paused) { userPaused = false; play() } else { userPaused = true; v.pause() }
    })
    v.addEventListener('click', function () { btn.click() })

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
    if (!reduce.matches) play()
  }

  function copy() {
    var btn = document.getElementById('copy')
    var code = document.getElementById('cmds')
    if (!btn || !code || !navigator.clipboard) return
    btn.hidden = false
    var timer
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(code.textContent.trim() + '\n').then(function () {
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
  copy()
})()
