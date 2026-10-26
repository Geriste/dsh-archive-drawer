/**
 * dsh-archive-drawer —— 浏览器半侧（手写的 __ModuleLoader__ bundle，不需要构建工具）
 *
 * 在侧边栏挂一个「归档」入口（slot: sidebar.panellist），点开是这个插件自己的
 * 中央面板（slot: main，key = dsh-archive-drawer）。面板里：
 *   · 统一列出所有已归档的会话（标题 / 工作区 / 归档时间 / 总结状态）
 *   · 一键「恢复」——调官方 clients 侧 workspaces.unarchiveSession 把会话放回原工作区
 *   · 「生成总结 / 重新生成」——让宿主端补一份归档文档
 *   · 「看总结」——内联展开宿主写好的 Markdown
 *
 * 与宿主端只走同源 HTTP（/dsh-archive-drawer/api/*），不碰 RPC：失败模式最少，
 * 也没有 connection 服务缺失的降级分支。
 *
 * 修改后 `node --check lib/client.js` 验证语法（它是表达式不是语句，
 * check 只验语法不执行）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-archive-drawer',
  factory: function (require) {
    // 加载器调用 factory(require) 时只给 require，不给 module —— 必须自己造。
    // 少了这两行，结尾的 module.exports 会在求值阶段抛 ReferenceError，
    // 整个 client entry 直接 import failed（整个 web boot 起不来）。
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useRef = React.useRef
    var useState = React.useState

    var NS = 'dsh-archive-drawer'
    var PANEL_ID = 'dsh-archive-drawer'
    var ROUTE_PREFIX = '/dsh-archive-drawer'
    var POLL_BUSY_MS = 2500
    var POLL_IDLE_MS = 20000

    /** 同源 API 路径，与 dsh-market 同款写法（要跟宿主注册的 path 完全一致）。 */
    function api(path) {
      var relative = String(path).replace(/^\/+/, '')
      if (typeof document === 'undefined') return '/' + relative
      return new URL(relative, document.baseURI).pathname
    }

    function shortId(sessionId) {
      var text = String(sessionId || '')
      if (text.length <= 14) return text
      return text.slice(0, 6) + '…' + text.slice(-6)
    }

    function formatTime(value) {
      var ms = Number(value)
      if (!Number.isFinite(ms) || ms <= 0) return '未知时间'
      var d = new Date(ms)
      if (Number.isNaN(d.getTime())) return '未知时间'
      var p = function (n) { return String(n).padStart(2, '0') }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    function formatBytes(bytes) {
      var n = Number(bytes) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    // ---- 极简 Markdown 渲染（只支持总结文档用到的这几种） ------------------

    function renderInline(text) {
      var parts = []
      var rest = String(text)
      var pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
      var last = 0
      var match
      var key = 0
      while ((match = pattern.exec(rest)) !== null) {
        if (match.index > last) parts.push(rest.slice(last, match.index))
        var token = match[0]
        if (token.startsWith('**')) parts.push(h('strong', { key: 'b' + key }, token.slice(2, -2)))
        else parts.push(h('code', { key: 'c' + key }, token.slice(1, -1)))
        key += 1
        last = match.index + token.length
      }
      if (last < rest.length) parts.push(rest.slice(last))
      return parts
    }

    function Markdown(props) {
      var text = typeof props.text === 'string' ? props.text : ''
      var nodes = useMemo(function () {
        var out = []
        var lines = text.split(/\r?\n/)
        var index = 0
        var key = 0
        while (index < lines.length) {
          var line = lines[index]
          var trimmed = line.trim()
          if (trimmed === '') { index += 1; continue }
          if (trimmed === '---') { out.push(h('hr', { key: 'hr' + key++ })); index += 1; continue }
          if (/^```/.test(trimmed)) {
            var code = []
            index += 1
            while (index < lines.length && !/^```/.test(lines[index].trim())) { code.push(lines[index]); index += 1 }
            index += 1
            out.push(h('pre', { key: 'pre' + key++, className: 'da-code' }, code.join('\n')))
            continue
          }
          var heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
          if (heading) {
            var level = heading[1].length
            out.push(h('div', { key: 'h' + key++, className: 'da-h da-h' + level }, renderInline(heading[2])))
            index += 1
            continue
          }
          if (/^>\s?/.test(trimmed)) {
            var quote = []
            while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
              quote.push(lines[index].trim().replace(/^>\s?/, ''))
              index += 1
            }
            out.push(h('blockquote', { key: 'q' + key++, className: 'da-quote' }, renderInline(quote.join(' '))))
            continue
          }
          if (/^[-*]\s+/.test(trimmed)) {
            var items = []
            while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
              items.push(h('li', { key: 'li' + key++ }, renderInline(lines[index].trim().replace(/^[-*]\s+/, ''))))
              index += 1
            }
            out.push(h('ul', { key: 'ul' + key++, className: 'da-ul' }, items))
            continue
          }
          var para = []
          while (index < lines.length) {
            var candidate = lines[index].trim()
            if (candidate === '' || /^(#{1,4}\s|>|[-*]\s|```|---)/.test(candidate)) break
            para.push(candidate)
            index += 1
          }
          out.push(h('p', { key: 'p' + key++, className: 'da-p' }, renderInline(para.join(' '))))
        }
        return out
      }, [text])
      return h('div', { className: 'da-md' }, nodes)
    }

    /** 面板崩了也要看得见原因，而不是整块白屏。 */
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        console.error('[dsh-archive-drawer] 面板渲染失败：', error)
      }
      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'da-root' },
            h('div', { className: 'da-error' },
              h('div', { className: 'da-error-title' }, '归档面板出错了'),
              h('div', { className: 'da-error-body' }, String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)),
              h('button', {
                type: 'button',
                className: 'da-btn da-btn-primary',
                onClick: function () { window.location.reload() },
              }, '刷新页面'),
            ),
          )
        }
        return this.props.children
      }
    }

    function ArchiveIcon(props) {
      var size = props && props.size ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 1.6, y: 3.2, width: 12.8, height: 3.2, rx: 1 }),
        h('path', { d: 'M2.8 6.4h10.4v5.2a1.2 1.2 0 0 1-1.2 1.2H4a1.2 1.2 0 0 1-1.2-1.2z' }),
        h('path', { d: 'M6.4 9.2h3.2' }),
      )
    }

    function StatusBadge(props) {
      var status = props.status
      var map = {
        none: ['未生成', 'da-badge-idle'],
        queued: ['排队中', 'da-badge-warn'],
        running: ['生成中…', 'da-badge-warn'],
        done: ['已生成', 'da-badge-ok'],
        failed: ['生成失败', 'da-badge-err'],
      }
      var entry = map[status] || map.none
      return h('span', { className: 'da-badge ' + entry[1] }, entry[0])
    }

    // ---- 主面板 -----------------------------------------------------------

    function ArchivePanel(props) {
      var ctx = props.ctx
      var [snapshot, setSnapshot] = useState(null)
      var [error, setError] = useState('')
      var [notice, setNotice] = useState('')
      var [busyId, setBusyId] = useState('')
      var [openId, setOpenId] = useState('')
      var [docs, setDocs] = useState({})
      /** 删除确认框：{ item, kind: 'has' | 'none', working } 或 { items, kind: 'batch-*', working } */
      var [ask, setAsk] = useState(null)
      /** 多选：{ [sessionId]: true } */
      var [selected, setSelected] = useState({})
      var alive = useRef(true)

      useEffect(function () {
        alive.current = true
        return function () { alive.current = false }
      }, [])

      var load = useCallback(function () {
        return fetch(api(ROUTE_PREFIX + '/api/state'), { cache: 'no-store' })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(function (body) {
            if (!alive.current) return
            if (body && body.ok === false) throw new Error(body.error || '未知错误')
            setSnapshot(body)
            setError('')
          })
          .catch(function (failure) {
            if (!alive.current) return
            setError(failure && failure.message ? failure.message : String(failure))
          })
      }, [])

      useEffect(function () {
        void load()
      }, [load])

      var busy = !!(snapshot && snapshot.busy)
      useEffect(function () {
        var timer = setInterval(function () { void load() }, busy ? POLL_BUSY_MS : POLL_IDLE_MS)
        return function () { clearInterval(timer) }
      }, [busy, load])

      var flash = useCallback(function (message) {
        setNotice(message)
        setTimeout(function () { if (alive.current) setNotice('') }, 3200)
      }, [])

      var onRestore = useCallback(function (item) {
        var workspaces = ctx.workspaces || (typeof ctx.get === 'function' ? ctx.get('workspaces') : null)
        if (!workspaces || typeof workspaces.unarchiveSession !== 'function') {
          flash('宿主没有 workspaces 服务，恢复不了')
          return
        }
        setBusyId(item.sessionId)
        workspaces.unarchiveSession(item.sessionId)
          .then(function () {
            flash('已恢复：' + (item.title || shortId(item.sessionId)))
            return load()
          })
          .catch(function (failure) {
            flash('恢复失败：' + (failure && failure.message ? failure.message : String(failure)))
          })
          .then(function () { if (alive.current) setBusyId('') })
      }, [ctx, flash, load])

      var onSummarize = useCallback(function (item, force) {
        setBusyId(item.sessionId)
        fetch(api(ROUTE_PREFIX + '/api/summarize'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: item.sessionId, force: force === true }),
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (body && body.ok === false) throw new Error(body.error || '未知错误')
            flash(body && body.queued === 0 ? '已经在队列里了' : '已加入生成队列')
            return load()
          })
          .catch(function (failure) {
            flash('提交失败：' + (failure && failure.message ? failure.message : String(failure)))
          })
          .then(function () { if (alive.current) setBusyId('') })
      }, [flash, load])

      var onSummarizeAll = useCallback(function () {
        setBusyId('__all__')
        fetch(api(ROUTE_PREFIX + '/api/summarize'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ all: true, force: false }),
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (body && body.ok === false) throw new Error(body.error || '未知错误')
            flash('已把 ' + (body.queued || 0) + ' 个会话排进总结队列')
            return load()
          })
          .catch(function (failure) {
            flash('提交失败：' + (failure && failure.message ? failure.message : String(failure)))
          })
          .then(function () { if (alive.current) setBusyId('') })
      }, [flash, load])

      var onReveal = useCallback(function (target) {
        fetch(api(ROUTE_PREFIX + '/api/reveal'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: target || 'root' }),
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (body && body.ok === true) return
            var fallback = target === 'trash'
              ? (snapshot && snapshot.trashDir) || ''
              : (snapshot && snapshot.summariesDir) || ''
            flash('宿主不能打开目录，路径已复制：' + fallback)
            if (fallback !== '' && navigator.clipboard) {
              navigator.clipboard.writeText(fallback).catch(function () {})
            }
          })
          .catch(function () { flash('打开目录失败') })
      }, [flash, snapshot])

      // ---- 彻底删除 ---------------------------------------------------------

      var onAskDelete = useCallback(function (item) {
        var done = !!(item.summary && item.summary.status === 'done')
        setAsk({ item: item, kind: done ? 'has' : 'none', working: false })
      }, [])

      /** summarizeFirst=true 时先让宿主补一份总结，总结失败就整体中止，不删。 */
      var runDelete = useCallback(function (item, summarizeFirst) {
        setAsk(function (prev) {
          return prev === null ? prev : Object.assign({}, prev, { working: true })
        })
        setBusyId(item.sessionId)
        fetch(api(ROUTE_PREFIX + '/api/delete'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: item.sessionId, summarizeFirst: summarizeFirst === true }),
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (body && body.ok === false) throw new Error(body.error || '未知错误')
            flash('已删到回收站：' + (item.title || shortId(item.sessionId)))
            if (alive.current) setAsk(null)
            return load()
          })
          .catch(function (failure) {
            flash('删除失败：' + (failure && failure.message ? failure.message : String(failure)))
            if (alive.current) {
              setAsk(function (prev) {
                return prev === null ? prev : Object.assign({}, prev, { working: false })
              })
            }
          })
          .then(function () { if (alive.current) setBusyId('') })
      }, [flash, load])

      // ---- 只删总结文件 -----------------------------------------------------

      var onAskDeleteDoc = useCallback(function (item) {
        setAsk({ item: item, kind: 'doc', working: false })
      }, [])

      var runDeleteDoc = useCallback(function (item) {
        setAsk(function (prev) {
          return prev === null ? prev : Object.assign({}, prev, { working: true })
        })
        setBusyId(item.sessionId)
        fetch(api(ROUTE_PREFIX + '/api/delete-doc'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: item.sessionId }),
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (body && body.ok === false) throw new Error(body.error || '未知错误')
            flash('总结已删到回收站：' + (item.title || shortId(item.sessionId)))
            if (alive.current) {
              setAsk(null)
              setDocs(function (prev) {
                var next = Object.assign({}, prev)
                delete next[item.sessionId]
                return next
              })
              if (openId === item.sessionId) setOpenId('')
            }
            return load()
          })
          .catch(function (failure) {
            flash('删除总结失败：' + (failure && failure.message ? failure.message : String(failure)))
            if (alive.current) {
              setAsk(function (prev) {
                return prev === null ? prev : Object.assign({}, prev, { working: false })
              })
            }
          })
          .then(function () { if (alive.current) setBusyId('') })
      }, [flash, load, openId])

      var onToggleDoc = useCallback(function (item) {
        if (openId === item.sessionId) { setOpenId(''); return }
        setOpenId(item.sessionId)
        if (docs[item.sessionId]) return
        fetch(api(ROUTE_PREFIX + '/api/doc?sessionId=' + encodeURIComponent(item.sessionId)), { cache: 'no-store' })
          .then(function (response) {
            if (!response.ok) throw new Error('还没有总结文档')
            return response.text()
          })
          .then(function (text) {
            if (!alive.current) return
            setDocs(function (prev) {
              var next = Object.assign({}, prev)
              next[item.sessionId] = text
              return next
            })
          })
          .catch(function (failure) {
            if (!alive.current) return
            setDocs(function (prev) {
              var next = Object.assign({}, prev)
              next[item.sessionId] = '__ERROR__' + (failure && failure.message ? failure.message : String(failure))
              return next
            })
          })
      }, [docs, openId])

      var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
      var doneCount = items.filter(function (item) { return item.summary && item.summary.status === 'done' }).length

      // ---- 多选 -------------------------------------------------------------

      var selectedItems = items.filter(function (item) { return selected[item.sessionId] === true })
      var selectedCount = selectedItems.length
      var selectedDoneCount = selectedItems.filter(function (item) { return item.summary && item.summary.status === 'done' }).length

      // 列表刷新后，把已经不在列表里的选中项丢掉
      useEffect(function () {
        setSelected(function (prev) {
          var ids = Object.keys(prev)
          if (ids.length === 0) return prev
          var live = {}
          for (var i = 0; i < items.length; i += 1) live[items[i].sessionId] = true
          var next = {}
          var changed = false
          for (var j = 0; j < ids.length; j += 1) {
            if (live[ids[j]] === true) next[ids[j]] = true
            else changed = true
          }
          return changed ? next : prev
        })
      }, [snapshot])

      var onToggleSelect = function (id) {
        setSelected(function (prev) {
          var next = Object.assign({}, prev)
          if (next[id] === true) delete next[id]
          else next[id] = true
          return next
        })
      }

      var onSelectAll = function () {
        var all = {}
        for (var i = 0; i < items.length; i += 1) all[items[i].sessionId] = true
        setSelected(all)
      }

      var onClearSelect = function () { setSelected({}) }

      // ---- 批量操作 ---------------------------------------------------------

      var onBatchSummarize = function () {
        var ids = selectedItems.map(function (item) { return item.sessionId })
        if (ids.length === 0) return
        setBusyId('__batch__')
        fetch(api(ROUTE_PREFIX + '/api/summarize'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionIds: ids, force: false }),
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (body && body.ok === false) throw new Error(body.error || '未知错误')
            var queued = body.queued || 0
            var skipped = body.skipped || 0
            flash('已排进总结队列 ' + queued + ' 个' + (skipped > 0 ? '，' + skipped + ' 个跳过（已有总结或已在队列）' : ''))
            return load()
          })
          .catch(function (failure) {
            flash('批量生成失败：' + (failure && failure.message ? failure.message : String(failure)))
          })
          .then(function () { if (alive.current) setBusyId('') })
      }

      var onBatchRestore = function () {
        var list = selectedItems.slice()
        if (list.length === 0) return
        var workspaces = ctx.workspaces || (typeof ctx.get === 'function' ? ctx.get('workspaces') : null)
        if (!workspaces || typeof workspaces.unarchiveSession !== 'function') {
          flash('宿主没有 workspaces 服务，恢复不了')
          return
        }
        setBusyId('__batch__')
        var ok = 0
        var failed = 0
        var chain = Promise.resolve()
        list.forEach(function (item) {
          chain = chain.then(function () {
            return workspaces.unarchiveSession(item.sessionId).then(
              function () { ok += 1 },
              function () { failed += 1 },
            )
          })
        })
        chain
          .then(function () {
            flash('已恢复 ' + ok + ' 个' + (failed > 0 ? '，' + failed + ' 个失败' : ''))
            setSelected({})
            return load()
          })
          .catch(function (failure) {
            flash('批量恢复失败：' + (failure && failure.message ? failure.message : String(failure)))
          })
          .then(function () { if (alive.current) setBusyId('') })
      }

      var onAskBatchDelete = function () {
        if (selectedCount === 0) return
        setAsk({ items: selectedItems.slice(), kind: 'batch-delete', working: false })
      }

      var onAskBatchDeleteDoc = function () {
        var withDoc = selectedItems.filter(function (item) { return item.summary && item.summary.status === 'done' })
        if (withDoc.length === 0) { flash('选中的会话里没有已生成的总结'); return }
        setAsk({ items: withDoc, kind: 'batch-doc', working: false })
      }

      var markWorking = function () {
        setAsk(function (prev) { return prev === null ? prev : Object.assign({}, prev, { working: true }) })
      }

      var runBatchDeleteDoc = function (list) {
        markWorking()
        setBusyId('__batch__')
        fetch(api(ROUTE_PREFIX + '/api/delete-doc'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionIds: list.map(function (item) { return item.sessionId }) }),
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (body && body.ok === false) throw new Error(body.error || '未知错误')
            var failed = body.failed || 0
            flash('已删 ' + (body.done || 0) + ' 份总结到回收站' + (failed > 0 ? '，' + failed + ' 份失败' : ''))
            if (alive.current) {
              setAsk(null)
              setDocs(function (prev) {
                var next = Object.assign({}, prev)
                list.forEach(function (item) { delete next[item.sessionId] })
                return next
              })
              setOpenId('')
              setSelected({})
            }
            return load()
          })
          .catch(function (failure) {
            flash('批量删总结失败：' + (failure && failure.message ? failure.message : String(failure)))
            if (alive.current) {
              setAsk(function (prev) { return prev === null ? prev : Object.assign({}, prev, { working: false }) })
            }
          })
          .then(function () { if (alive.current) setBusyId('') })
      }

      var runBatchDelete = function (list, summarizeFirst) {
        markWorking()
        setBusyId('__batch__')
        fetch(api(ROUTE_PREFIX + '/api/delete'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionIds: list.map(function (item) { return item.sessionId }),
            summarizeFirst: summarizeFirst === true,
          }),
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) {
            if (body && body.ok === false) throw new Error(body.error || '未知错误')
            var failed = body.failed || 0
            flash('已删 ' + (body.done || 0) + ' 个会话到回收站' + (failed > 0 ? '，' + failed + ' 个失败' : ''))
            if (alive.current) { setAsk(null); setSelected({}) }
            return load()
          })
          .catch(function (failure) {
            flash('批量删除失败：' + (failure && failure.message ? failure.message : String(failure)))
            if (alive.current) {
              setAsk(function (prev) { return prev === null ? prev : Object.assign({}, prev, { working: false }) })
            }
          })
          .then(function () { if (alive.current) setBusyId('') })
      }

      /** 删除确认框：三种语气 —— 删对话(有总结) / 删对话(没总结) / 只删总结文件。 */
      var confirmNode = ask === null ? null : (function () {
        var kind = ask.kind
        var working = ask.working === true
        var cancel = h('button', {
          key: 'cancel',
          type: 'button',
          className: 'da-btn',
          disabled: working,
          onClick: function () { setAsk(null) },
        }, '取消')

        // ---- 批量确认框 ----
        if (kind === 'batch-doc' || kind === 'batch-delete') {
          var list = Array.isArray(ask.items) ? ask.items : []
          var count = list.length
          var missing = list.filter(function (item) { return !(item.summary && item.summary.status === 'done') })
          var preview = list.slice(0, 5).map(function (item) {
            return item.title || ('未命名会话 ' + shortId(item.sessionId))
          })
          var isDoc = kind === 'batch-doc'
          var title = isDoc ? ('删除这 ' + count + ' 份总结？') : ('彻底删除这 ' + count + ' 个对话？')
          var bodyText = isDoc
            ? '只删总结文件，对话本体一个都不动。文件会进回收站。'
            : missing.length === 0
              ? '总结都已生成好，会留在总结文件夹里当档案；' + count + ' 个对话本体整个移进回收站，还能捞回来。'
              : '其中 ' + missing.length + ' 个还没生成总结，删掉就没有留档摘要了。'
          var buttons
          if (isDoc) {
            buttons = [cancel, h('button', {
              key: 'ok',
              type: 'button',
              className: 'da-btn da-btn-danger',
              disabled: working,
              onClick: function () { runBatchDeleteDoc(list) },
            }, working ? '删除中…' : ('删这 ' + count + ' 份总结'))]
          } else {
            buttons = [cancel,
              h('button', {
                key: 'raw',
                type: 'button',
                className: 'da-btn' + (missing.length === 0 ? ' da-btn-danger' : ''),
                disabled: working,
                onClick: function () { runBatchDelete(list, false) },
              }, '不总结，直接删'),
              missing.length === 0
                ? null
                : h('button', {
                  key: 'sum',
                  type: 'button',
                  className: 'da-btn da-btn-primary',
                  disabled: working,
                  onClick: function () { runBatchDelete(list, true) },
                }, working ? '生成总结中…' : '先补齐总结，再删')]
          }
          return h('div', {
            className: 'da-modal',
            onClick: function () { if (working !== true) setAsk(null) },
          },
            h('div', {
              className: 'da-modal-card',
              onClick: function (event) { event.stopPropagation() },
            },
              h('div', { className: 'da-modal-title' }, title),
              h('div', { className: 'da-modal-name' }, preview.join('、') + (count > preview.length ? ' 等 ' + count + ' 个' : '')),
              h('div', { className: 'da-modal-body' }, bodyText),
              h('div', { className: 'da-modal-row' }, buttons),
            ),
          )
        }

        var title = kind === 'doc' ? '删除这份上下文总结？' : '彻底删除这个对话？'
        var body = kind === 'doc'
          ? '只删总结文件，对话本体不动。文件会进回收站，点错了还能捞回来。'
          : kind === 'has'
            ? '总结已经生成好，会留在总结文件夹里当档案；对话本体整个移进回收站，要捞回来还能捞。'
            : '这个对话还没生成总结。删掉之后就没有留档摘要了，建议先生成再删。'
        var cancel = h('button', {
          key: 'cancel',
          type: 'button',
          className: 'da-btn',
          disabled: working,
          onClick: function () { setAsk(null) },
        }, '取消')
        var buttons
        if (kind === 'doc') {
          buttons = [cancel, h('button', {
            key: 'ok',
            type: 'button',
            className: 'da-btn da-btn-danger',
            disabled: working,
            onClick: function () { runDeleteDoc(ask.item) },
          }, working ? '删除中…' : '删总结到回收站')]
        } else if (kind === 'has') {
          buttons = [cancel, h('button', {
            key: 'ok',
            type: 'button',
            className: 'da-btn da-btn-danger',
            disabled: working,
            onClick: function () { runDelete(ask.item, false) },
          }, working ? '删除中…' : '删到回收站')]
        } else {
          buttons = [cancel,
            h('button', {
              key: 'raw',
              type: 'button',
              className: 'da-btn',
              disabled: working,
              onClick: function () { runDelete(ask.item, false) },
            }, '不总结，直接删'),
            h('button', {
              key: 'sum',
              type: 'button',
              className: 'da-btn da-btn-primary',
              disabled: working,
              onClick: function () { runDelete(ask.item, true) },
            }, working ? '生成总结中…' : '先生成总结，再删')]
        }
        return h('div', {
          className: 'da-modal',
          onClick: function () { if (working !== true) setAsk(null) },
        },
          h('div', {
            className: 'da-modal-card',
            onClick: function (event) { event.stopPropagation() },
          },
            h('div', { className: 'da-modal-title' }, title),
            h('div', { className: 'da-modal-name' }, ask.item.title || ('未命名会话 ' + shortId(ask.item.sessionId))),
            h('div', { className: 'da-modal-body' }, body),
            h('div', { className: 'da-modal-row' }, buttons),
          ),
        )
      })()

      return h('div', { className: 'da-root' },
        h('div', { className: 'da-head' },
          h('div', { className: 'da-head-row' },
            h('div', { className: 'da-title' }, '归档'),
            h('div', { className: 'da-actions' },
              h('button', { type: 'button', className: 'da-btn', onClick: onSummarizeAll }, '全部生成总结'),
              h('button', { type: 'button', className: 'da-btn', onClick: function () { onReveal('root') } }, '打开总结文件夹'),
              h('button', { type: 'button', className: 'da-btn', onClick: function () { onReveal('trash') } }, '打开回收站'),
              h('button', { type: 'button', className: 'da-btn', onClick: function () { void load() } }, '刷新'),
            ),
          ),
          h('div', { className: 'da-sub' },
            '已归档 ' + items.length + ' 个会话 · 已有总结 ' + doneCount + ' 份'
              + (snapshot && snapshot.trashCount > 0 ? ' · 回收站 ' + snapshot.trashCount + ' 个' : ''),
          ),
          items.length === 0
            ? null
            : h('div', { className: 'da-selbar' },
              h('label', { className: 'da-selall' },
                h('input', {
                  type: 'checkbox',
                  checked: selectedCount > 0 && selectedCount === items.length,
                  onChange: function () {
                    if (selectedCount > 0 && selectedCount === items.length) onClearSelect()
                    else onSelectAll()
                  },
                }),
                selectedCount === 0 ? '全选' : ('已选 ' + selectedCount + ' 项'),
              ),
              selectedCount === 0
                ? null
                : h('div', { className: 'da-actions' },
                  h('button', {
                    type: 'button',
                    className: 'da-btn da-btn-primary',
                    disabled: busyId !== '',
                    onClick: onBatchSummarize,
                  }, '批量生成总结'),
                  h('button', {
                    type: 'button',
                    className: 'da-btn da-btn-primary',
                    disabled: busyId !== '',
                    onClick: onBatchRestore,
                  }, '批量恢复'),
                  h('button', {
                    type: 'button',
                    className: 'da-btn da-btn-danger',
                    disabled: busyId !== '' || selectedDoneCount === 0,
                    onClick: onAskBatchDeleteDoc,
                    title: '只删选中的总结文件，对话本体不动',
                  }, '批量删总结' + (selectedDoneCount > 0 ? '（' + selectedDoneCount + '）' : '')),
                  h('button', {
                    type: 'button',
                    className: 'da-btn da-btn-danger',
                    disabled: busyId !== '',
                    onClick: onAskBatchDelete,
                    title: '把选中的对话本体移进回收站删除',
                  }, '批量删除对话'),
                  h('button', {
                    type: 'button',
                    className: 'da-btn',
                    disabled: busyId !== '',
                    onClick: onClearSelect,
                  }, '取消选择'),
                ),
            ),
          snapshot && snapshot.summariesDir
            ? h('div', { className: 'da-path', title: snapshot.summariesDir }, snapshot.summariesDir)
            : null,
          notice !== '' ? h('div', { className: 'da-notice' }, notice) : null,
          error !== '' ? h('div', { className: 'da-error' }, '读取失败：' + error) : null,
          snapshot && snapshot.lastError ? h('div', { className: 'da-hint' }, '宿主日志：' + snapshot.lastError) : null,
        ),

        items.length === 0
          ? h('div', { className: 'da-empty' },
            h('div', { className: 'da-empty-title' }, '还没有归档的对话'),
            h('div', { className: 'da-empty-body' }, '在左侧工作区里对着一个会话点「归档」，它就会出现在这里，并自动生成总结文档。'),
          )
          : h('div', { className: 'da-list' }, items.map(function (item) {
            var summary = item.summary || {}
            var expanded = openId === item.sessionId
            var docText = docs[item.sessionId]
            return h('div', {
              className: 'da-item'
                + (expanded ? ' da-item-open' : '')
                + (selected[item.sessionId] === true ? ' da-item-sel' : ''),
              key: item.sessionId,
            },
              h('label', { className: 'da-check', title: '选中这个会话' },
                h('input', {
                  type: 'checkbox',
                  checked: selected[item.sessionId] === true,
                  onChange: function () { onToggleSelect(item.sessionId) },
                }),
              ),
              h('div', { className: 'da-item-main' },
                h('div', { className: 'da-item-title' }, item.title || ('未命名会话 ' + shortId(item.sessionId))),
                h('div', { className: 'da-item-meta' },
                  item.workspace ? h('span', { className: 'da-meta-chip' }, item.workspace) : null,
                  item.deleted === true
                    ? h('span', { className: 'da-meta-chip da-meta-warn' }, '会话已删除')
                    : item.orphan === true
                      ? h('span', { className: 'da-meta-chip da-meta-dim' }, '会话已不在')
                      : null,
                  h('span', null, formatTime(item.createdAt)),
                  h('span', { className: 'da-mono' }, shortId(item.sessionId)),
                  summary.status === 'done'
                    ? h('span', { className: 'da-meta-chip da-meta-dim' }, formatBytes(summary.bytes))
                    : null,
                ),
                summary.status === 'failed' && summary.error
                  ? h('div', { className: 'da-item-err' }, summary.error)
                  : null,
              ),
              h('div', { className: 'da-item-side' },
                h(StatusBadge, { status: summary.status }),
                h('button', {
                  type: 'button',
                  className: 'da-btn da-btn-primary',
                  disabled: busyId !== '' || item.orphan === true,
                  onClick: function () { onRestore(item) },
                  title: item.orphan ? '这个会话已经不在当前工作区列表里了' : '放回原来的工作区',
                }, '恢复'),
                h('button', {
                  type: 'button',
                  className: 'da-btn',
                  disabled: busyId !== '',
                  onClick: function () { onSummarize(item, true) },
                }, summary.status === 'done' ? '重新生成' : '生成总结'),
                summary.status === 'done'
                  ? h('button', {
                    type: 'button',
                    className: 'da-btn',
                    onClick: function () { onToggleDoc(item) },
                  }, expanded ? '收起总结' : '看总结')
                  : null,
                summary.status === 'done'
                  ? h('button', {
                    type: 'button',
                    className: 'da-btn da-btn-danger',
                    disabled: busyId !== '',
                    onClick: function () { onAskDeleteDoc(item) },
                    title: '只删总结文件，对话本体不动',
                  }, '删总结')
                  : null,
                item.orphan === true
                  ? null
                  : h('button', {
                    type: 'button',
                    className: 'da-btn da-btn-danger',
                    disabled: busyId !== '',
                    onClick: function () { onAskDelete(item) },
                    title: '把对话本体移进回收站删除（总结文档保留）',
                  }, '删除'),
              ),
              expanded
                ? h('div', { className: 'da-doc' },
                  docText === undefined
                    ? h('div', { className: 'da-doc-loading' }, '载入中…')
                    : String(docText).startsWith('__ERROR__')
                      ? h('div', { className: 'da-error' }, String(docText).slice(9))
                      : h(Markdown, { text: docText }),
                )
                : null,
            )
          })),

        confirmNode,
      )
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.da-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:auto;',
      'color:var(--dsw-alias-label-primary,#241f18);background:var(--dsw-alias-bg-base,#fff);',
      'font-size:13px;line-height:1.6;padding:18px 22px 28px;}',
      '.da-root *{box-sizing:border-box;}',
      '.da-head{flex:0 0 auto;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));}',
      '.da-head-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.da-title{font-size:17px;font-weight:650;letter-spacing:.4px;}',
      '.da-actions{display:flex;gap:8px;flex-wrap:wrap;}',
      '.da-sub{margin-top:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.da-selbar{margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.da-selall{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none;',
      'color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.da-check{display:inline-flex;align-items:center;flex:0 0 auto;padding-top:2px;cursor:pointer;}',
      '.da-check input,.da-selall input{cursor:pointer;margin:0;}',
      '.da-item-sel{border-color:var(--dsw-alias-brand-primary,#241f18);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#241f18) 6%,var(--dsw-alias-bg-layer-1,#fffdf8));}',
      '.da-path{margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a8074);word-break:break-all;}',
      '.da-notice{margin-top:10px;padding:8px 12px;border-radius:8px;font-size:12.5px;',
      'border:1px solid var(--dsw-alias-state-success-primary,#2f6b46);color:var(--dsw-alias-state-success-primary,#2f6b46);}',
      '.da-hint{margin-top:8px;font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#8a6a2f);}',
      '.da-error{margin-top:10px;padding:9px 12px;border-radius:8px;font-size:12.5px;',
      'border:1px solid var(--dsw-alias-state-error-primary,#a83a2c);color:var(--dsw-alias-state-error-primary,#a83a2c);}',
      '.da-error-title{font-weight:650;margin-bottom:4px;}',
      '.da-error-body{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;word-break:break-all;}',
      '.da-empty{margin-top:48px;text-align:center;color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.da-empty-title{font-size:14px;font-weight:600;}',
      '.da-empty-body{margin-top:6px;font-size:12.5px;}',
      '.da-list{flex:1 1 auto;min-height:0;padding-top:12px;display:flex;flex-direction:column;gap:8px;}',
      '.da-item{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;padding:12px 14px;border-radius:11px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fffdf8);}',
      '.da-item-open{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.16));}',
      '.da-item-main{flex:1 1 260px;min-width:0;}',
      '.da-item-title{font-weight:600;font-size:13.5px;word-break:break-word;}',
      '.da-item-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:5px;',
      'font-size:11.5px;color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.da-item-err{margin-top:6px;font-size:11.5px;color:var(--dsw-alias-state-error-primary,#a83a2c);word-break:break-word;}',
      '.da-meta-chip{padding:1px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));}',
      '.da-meta-warn{color:var(--dsw-alias-state-warn-primary,#8a6a2f);',
      'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#8a6a2f) 12%,transparent);}',
      '.da-meta-dim{opacity:.8;}',
      '.da-mono{font-family:ui-monospace,Menlo,Consolas,monospace;}',
      '.da-item-side{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}',
      '.da-btn{appearance:none;cursor:pointer;font:inherit;font-size:12px;padding:5px 11px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:transparent;',
      'color:var(--dsw-alias-label-primary,#241f18);white-space:nowrap;}',
      '.da-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));}',
      '.da-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '.da-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#241f18);',
      'color:var(--dsw-alias-bg-base,#fffdf8);}',
      '.da-btn-primary:hover:not(:disabled){opacity:.88;background:var(--dsw-alias-brand-primary,#241f18);}',
      '.da-btn-danger{color:var(--dsw-alias-state-error-primary,#a83a2c);',
      'border-color:var(--dsw-alias-state-error-primary,#a83a2c);}',
      '.da-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#a83a2c) 10%,transparent);}',
      '.da-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;',
      'padding:24px;background:rgba(0,0,0,.36);}',
      '.da-modal-card{width:min(460px,100%);padding:20px 22px;border-radius:14px;',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#241f18);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));box-shadow:0 18px 48px rgba(0,0,0,.24);}',
      '.da-modal-title{font-size:15px;font-weight:650;}',
      '.da-modal-name{margin-top:8px;font-size:12.5px;font-weight:600;word-break:break-word;',
      'color:var(--dsw-alias-label-primary,#241f18);}',
      '.da-modal-body{margin-top:8px;font-size:12.5px;line-height:1.65;',
      'color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.da-modal-row{margin-top:18px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;}',
      '.da-badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap;}',
      '.da-badge-ok{color:var(--dsw-alias-state-success-primary,#2f6b46);}',
      '.da-badge-warn{color:var(--dsw-alias-state-warn-primary,#8a6a2f);}',
      '.da-badge-err{color:var(--dsw-alias-state-error-primary,#a83a2c);}',
      '.da-badge-idle{color:var(--dsw-alias-label-secondary,#8a8074);}',
      '.da-doc{flex:1 1 100%;margin-top:6px;padding:14px 16px;border-radius:10px;max-height:60vh;overflow:auto;',
      'background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));}',
      '.da-doc-loading{color:var(--dsw-alias-label-secondary,#6f6558);font-size:12.5px;}',
      '.da-md{font-size:12.5px;}',
      '.da-h{font-weight:650;margin:12px 0 5px;}',
      '.da-h1{font-size:15px;}',
      '.da-h2{font-size:13.5px;}',
      '.da-h3,.da-h4{font-size:12.5px;}',
      '.da-h:first-child{margin-top:0;}',
      '.da-p{margin:5px 0;word-break:break-word;}',
      '.da-ul{margin:5px 0 5px 18px;padding:0;}',
      '.da-ul li{margin:2px 0;}',
      '.da-quote{margin:6px 0;padding:5px 10px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));',
      'color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.da-code{margin:6px 0;padding:9px 11px;border-radius:8px;overflow:auto;font-size:11.5px;',
      'font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));}',
      '.da-md code{padding:1px 5px;border-radius:5px;font-size:11.5px;',
      'font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));}',
      '.da-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));margin:12px 0;}',
    ].join('')

    // ---- 注册 -------------------------------------------------------------

    function apply(ctx) {
      // 样式随插件生命周期：<style data-dsh-archive-drawer> 挂上，卸载时摘掉
      ctx.effect(function () {
        var id = 'dsh-archive-drawer-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-archive-drawer: styles')

      var disposers = []
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            var dispose = disposers[i]
            if (typeof dispose === 'function') {
              try { dispose() } catch (error) { console.warn('[dsh-archive-drawer] 卸载槽位失败', error) }
            }
          }
          disposers.length = 0
        }
      }, 'dsh-archive-drawer: slots')

      var renderPanel = function (ownerProps) {
        var props = ownerProps !== null && ownerProps !== undefined ? ownerProps : {}
        return h(ErrorBoundary, null, h(ArchivePanel, Object.assign({}, props, { ctx: ctx })))
      }
      var renderIcon = function (owner) {
        return h(ArchiveIcon, { size: (owner && owner.size) || 16 })
      }

      // sidebar.panellist 全局行必须等宿主声明了才注册：老宿主没有这个槽，
      // inject 不会回调，插件就安静地缺席，而不是把宿主点着。
      ctx.slots.inject('sidebar.panellist', function () {
        disposers.push(ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, renderPanel))
        disposers.push(ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 2,
          locale: NS,
          label: function () { return '归档' },
        }, renderIcon))
      })
    }

    module.exports = {
      name: 'dsh-archive-drawer',
      inject: ['slots', 'workspaces'],
      apply: apply,
    }
    return module.exports
  },
})
