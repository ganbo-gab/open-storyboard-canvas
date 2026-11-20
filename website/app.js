/* ==========================================================================
   Open Storyboard Canvas — Official Website Interactive Engine
   - Bilingual i18n (zh-CN / en)
   - GSAP 3 + ScrollTrigger 4-Act Cinema Camera Sequence (with native fallback)
   - Off-screen auto-pausing 3D Hero Canvas & Interactive 3D Director Previs Lab
   - Lightbox, Spotlight, OS Detection, CinemaScope 2.39:1 Toggle
   ========================================================================== */

(() => {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------------
     1. Bilingual Copy Dictionary (100% factual, v0.2.2)
  ------------------------------------------------------------------------ */
  const I18N = {
    zh: {
      brandSub: '开源画布 · v0.2.2',
      navWorkflow: '创作链路',
      navPlayground: '3D 运镜试玩',
      navFeatures: '核心能力',
      navGallery: '实机画面',
      navDownload: '下载',
      heroBadge: '本地优先 · MIT 开源 · macOS & Windows',
      heroTitle1: '节点画布与三维导演台',
      heroTitle2: '装进同一个本地桌面',
      heroDesc:
        '在工作台试完模型，直接拉进节点画布组合迭代；需要定构图和人物走位，切进三维预演台拍四视图送回画布。项目、历史与素材默认存在你自己的硬盘里。',
      heroCtaDownload: '下载 v0.2.2',
      heroCtaDownloadMac: '下载 macOS 版',
      heroCtaDownloadWin: '下载 Windows 版',
      heroCtaTry: '试玩 3D 运镜',
      heroCtaStar: '源码仓库',
      heroFootNote:
        '基于 Tauri 2、React 19、TypeScript、Rust 与 Three.js · 支持多模型中转站、ComfyUI 与即梦 CLI',
      heroShotNote: '看懂这张画面：预演台拍出四视图，直接连回画布节点',
      scrollCue: '向下滚动 · 按镜头浏览完整流程',
      seqTitle: '顺着一条镜头，看完创作全流程',
      act1Tag: 'SHOT 01 · 24mm 推轨进入',
      act1Title: '生成工作台：先试出满意的底图与素材',
      act1Desc:
        '图片、视频、音频和文本对话都在同一个工作台里。输入区打 <code>@</code> 引用素材，打 <code>/</code> 选预设；每次提交都记下当时的模型、参数和原任务 ID，查旧结果不会误点重扣费。',
      act1P1: '尺寸支持像素与“比例 + 分辨率”切换，底层仍按渠道真实值提交',
      act1P2: '同一批多张结果可直接对比、下载、设为参考或送进画布',
      act2Tag: 'SHOT 02 · 35mm 水平横摇',
      act2Title: '无限节点画布：把零散结果接成工作流',
      act2Desc:
        '把文本、参考图、生成、分镜、全景和导演台节点连起来持续迭代。独立摄像机弹窗可调机身、焦距和光圈，不随画布缩放；裁剪标注后存成新副本，保留原图和来源连线。',
      act2P1: '鼠标左/中/右键共 9 项操作独立可配，提供左拖平移推荐预设',
      act2P2: '大画布做过视口裁剪与矢量连线缓存，缩放拖动更跟手',
      act3Tag: 'SHOT 03 · 50mm 三维环绕',
      act3Title: '三维导演台与预演台：把机位和走位摆明白',
      act3Desc:
        '在三维空间或全景背景里放人物、道具、灯光和摄影机，在地面直接画走位路线、在时间轴调关键帧。随时拍单张或四视图送回画布，也支持用实验性舞台 Agent 搭出可编辑草稿。',
      act3P1: '摄影机支持跟随人物、看向固定点与自由旋转',
      act3P2: '支持 GLB/glTF 导入、录制以及按渠道能力调用图生 3D',
      act4Tag: 'SHOT 04 · 85mm 焦点锁定',
      act4Title: '三端 Agent 与多模型渠道：可控、可查、不盲跑',
      act4Desc:
        '首页、画布和舞台各自带一个懂当前上下文的助手，支持请求确认、辅助执行、完全执行三种权限。渠道同时管单模型、中转站、ComfyUI 和即梦 CLI，API Key 交给系统钥匙串独立保管。',
      act4P1: '单回合 96 次调用 / 30 分钟保护，出错可续接，不乱重发付费任务',
      act4P2: '支持挂载本地 Markdown / Obsidian 目录当项目知识库',
      tab1: '生成工作台',
      tab2: '节点画布',
      tab3: '三维导演台',
      tab4: 'Agent 与渠道',
      playTitle: '先在这里试一下导演台的运镜与机位',
      playSub:
        '左键拖动就能环绕舞台；点右侧 5 种经典机位，虚拟摄影机会沿着轨道飞过去，右侧画中画同步显示镜头拍到的构图。',
      camWide: '24mm 建立广角',
      camDolly: '50mm 推轨特写',
      camOrbit: '360° 环绕运镜',
      camCrane: '摇臂俯拍',
      camFour: '四视图连拍',
      stageDragHint: '拖动自由环绕 · 点击按钮切换运镜',
      playPause: '暂停走位',
      playResume: '继续走位',
      pipTitle: '机位画中画 · LIVE LENS',
      mExplainLabel: '看懂这张图',
      mExplainVal:
        '青色视锥体代表虚拟摄影机，虚线是人物 12 秒相遇走位，点击“四视图连拍”可看到多机位轮切。',
      mExport: '桌面端联动',
      mExportVal:
        '真实桌面版基于 Three.js，支持 GLB 导入、全景背景、关键帧录制，并直接把四视图送回节点画布。',
      featTitle: '五大模块，全部按真实桌面源码整理',
      featSub: '不夸大、不画饼，以下每一项能力都对应当前 v0.2.2 仓库里的实际功能。',
      f1Title: '生成工作台与历史追溯',
      f1Desc:
        '图像、视频、音频和文本对话集中在同一工作台。按创作会话归档，支持 <code>@</code> 引用素材与 <code>/</code> 预设；任务中心分开展示进行中与异常暂停项，查询原任务与再次生成严格隔离。',
      f2Title: '无限节点画布',
      f2Desc:
        '文本、媒体、生成、分镜、全景与导演台节点自由连接；独立摄像机弹窗、9 项鼠标键位自定义，图片与音视频编辑均存衍生副本并保留来源连线。',
      f3Title: '三维导演台与预演台',
      f3Desc:
        '在 3D 场景或全景背景里摆人物、道具、灯光与机位，画路线调关键帧；拍单张或四视图直接送回画布，并支持实验性舞台 Agent 搭建可编辑草稿。',
      f4Title: '首页 / 画布 / 舞台三端 Agent 与本地知识库',
      f4Desc:
        '三个入口各自读取当前页面上下文，提供请求确认、辅助执行和完全执行三种模式；共享 96 次调用 / 30 分钟保护、失败续接与脱敏统计，不开放任意系统命令。可直接挂本地 Markdown / Obsidian 目录检索笔记。',
      f5Title: '单模型、综合中转站与 ComfyUI 统一接入',
      f5Desc:
        '支持协议模板、让 AI 读接口文档生成配置、或直接粘贴配置 JSON；免费拉取模型列表与计费试运行严格分开，支持批量“统一配置”、ComfyUI 多工作流 AI 绑定分析与 Dreamina（即梦）CLI。所有 API Key 单独保存在 macOS 系统钥匙串或 Windows 凭据管理器里。',
      galTitle: '桌面端真实画面',
      galSub:
        '点击任意卡片打开大图查看器，按 Esc 或点空白处关闭。演示使用本地测试素材与模拟接口，用于展示真实界面与操作流程。',
      galAll: '全部',
      galGif: '操作动图',
      galStatic: '静态界面',
      g1T: '渠道与模型广场',
      g1D: '按模态筛选、切换视图、查看参数槽位',
      g2T: '工作台生成与追溯',
      g2D: '保留提交模型、参数与原任务快照',
      g3T: 'Agent 审批与权限',
      g3D: '先看清工具操作，再点批准或拒绝',
      g4T: '可调工作区与项目归属',
      g4D: '分隔线拖宽、双击复位并记住尺寸',
      g5T: '舞台 Agent 实测（实验中）',
      g5D: '2026-11-07 实测：建筑与 15 秒镜头编排',
      g6T: '预演台与时间轴',
      g6D: '地面路径、机位跟踪与实时画中画',
      dlTitle: '下载桌面版，免费开源',
      dlSub: '已自动识别你的系统并高亮推荐安装包；桌面安装程序统一从 GitHub Releases 下载。',
      osUniversal: 'Apple Silicon & Intel',
      osRecommended: '推荐当前系统',
      macHint: 'macOS 11.0+ · 首次打开若被系统拦截，请在“隐私与安全性”允许打开',
      winHint: 'Windows x64 · 如提示缺少 WebView 请安装 Edge WebView2 Runtime',
      dlAllReleases: '全部版本与更新日志 ↗',
      dlDocs: '完整使用文档 ↗',
      honestTitle: '先说在前面的边界',
      honest1:
        '<strong>macOS 签名：</strong>目前是临时签名，更新版本后钥匙串可能再次要求确认，不承诺零弹窗。',
      honest2:
        '<strong>实验功能：</strong>内置 Agent 与舞台 Agent 仍在持续打磨，不同中转站协议与复杂编排可能遇到兼容问题。',
      honest3:
        '<strong>数据与费用：</strong>项目与素材存在本机；生成请求按你的配置发往第三方供应商或本地工具，费用以供应商为准。',
      qqLabel: '中文交流与反馈 QQ 群',
      copyQq: '复制群号',
      copiedQq: '已复制 ✓',
      footerAttr:
        '基于 <a href="https://github.com/henjicc/Storyboard-Copilot" target="_blank" rel="noopener noreferrer">henjicc / 痕继痕迹 — Storyboard-Copilot</a> 获书面授权二次开发 · 新增代码按 MIT License 开源。',
    },
    en: {
      brandSub: 'Local Desktop · v0.2.2',
      navWorkflow: 'Workflow',
      navPlayground: '3D Camera Lab',
      navFeatures: 'Features',
      navGallery: 'Footage',
      navDownload: 'Download',
      heroBadge: 'LOCAL-FIRST · MIT OPEN SOURCE · MACOS & WINDOWS',
      heroTitle1: 'Infinite Node Canvas &',
      heroTitle2: '3D Director Studio on Desktop',
      heroDesc:
        'Test multi-provider AI models in the workbench, compose reusable node workflows on an infinite canvas, and block 3D cameras & trajectories to capture 4-view shots back into your graph—all stored locally.',
      heroCtaDownload: 'Download v0.2.2',
      heroCtaDownloadMac: 'Download for macOS (v0.2.2)',
      heroCtaDownloadWin: 'Download for Windows (v0.2.2)',
      heroCtaTry: 'Try 3D Camera Rig',
      heroCtaStar: 'Source Code',
      heroFootNote:
        'Built with Tauri 2, React 19, TypeScript, Rust & Three.js · Supports Multi-Provider Relays, ComfyUI & Dreamina CLI',
      heroShotNote: 'What you see: 3D Previs captures 4-view shots and links them straight back to the node canvas',
      scrollCue: 'Scroll to scrub through the 4-act workflow',
      seqTitle: 'One continuous local storyboarding pipeline',
      act1Tag: 'SHOT 01 · 24mm DOLLY IN',
      act1Title: 'Generation Workbench: iterate fast with traceable history',
      act1Desc:
        'Images, video, audio, and chat share one session-based workbench. Type <code>@</code> to reference assets and <code>/</code> for presets. Every submission logs its exact model, parameters, and upstream task ID—keeping status checks separate from paid retries.',
      act1P1: 'Switch between pixel sizes and aspect-ratio + resolution while preserving API values',
      act1P2: 'Inspect multi-output batches, download, reuse as reference, or send to any canvas',
      act2Tag: 'SHOT 02 · 35mm TRACKING PAN',
      act2Title: 'Infinite Node Canvas: turn outputs into reusable graphs',
      act2Desc:
        'Wire text, media, generation, storyboard, panorama, and Director Studio nodes together. Use a zoom-independent floating camera modal and non-destructive editing that saves derived copies with source links.',
      act2P1: '9 independently customizable mouse button actions plus recommended pan/select presets',
      act2P2: 'Spatial indexing, viewport culling, and fallback-safe vector edge caching for large canvases',
      act3Tag: 'SHOT 03 · 50mm 3D ORBIT',
      act3Title: '3D Director Studio & Previs: block shots before generating',
      act3Desc:
        'Place characters, props, lights, and cameras inside 3D stages or panorama backdrops. Sketch ground paths, edit keyframes on a timeline, send single or 4-view captures back to the canvas, or try the experimental Stage Agent.',
      act3P1: 'Camera modes for follow-target, look-at point, and free orbit',
      act3P2: 'GLB/glTF import, stage recording, and configured image-to-3D generation',
      act4Tag: 'SHOT 04 · 85mm LOCK-ON',
      act4Title: 'Scoped Agents & Multi-Provider Channels: explicit control',
      act4Desc:
        'Home, Canvas, and Stage each have a context-aware assistant with Ask / Assisted / Full execution modes. Manage single models, relays, ComfyUI workflows, and Dreamina CLI with API keys isolated in OS credential stores.',
      act4P1: '96 tool calls / 30 min turn guardrails, receipt-preserving resume, and sanitized diagnostics',
      act4P2: 'Mount any local Markdown / Obsidian folder as a searchable knowledge base',
      tab1: 'Workbench',
      tab2: 'Node Canvas',
      tab3: '3D Director',
      tab4: 'Agents & Channels',
      playTitle: 'Try the 3D Director Camera Rig right here',
      playSub:
        'Drag the viewport to orbit freely, or trigger 5 classic camera moves. Watch the virtual rig fly along 3D trajectories while the live picture-in-picture monitor renders the lens view.',
      camWide: '24mm Wide',
      camDolly: '50mm Dolly In',
      camOrbit: '360° Orbit',
      camCrane: 'Crane Top-Down',
      camFour: '4-View Capture',
      stageDragHint: 'Drag to orbit · Click presets for camera moves',
      playPause: 'Pause Blocking',
      playResume: 'Resume Blocking',
      pipTitle: 'LIVE LENS MONITOR · PIP',
      mExplainLabel: 'How to read this stage',
      mExplainVal:
        'The cyan frustum is the virtual camera, dashed lines show a 12-second blocking path, and “4-View Capture” cycles four angles automatically.',
      mExport: 'In the desktop app',
      mExportVal:
        'Powered by Three.js with GLB/glTF import, panorama backdrops, keyframe recording, and one-click 4-view return to the node canvas.',
      featTitle: 'Five core modules grounded in v0.2.2 source',
      featSub: 'No inflated claims—every capability below maps directly to the current open-source codebase.',
      f1Title: 'Generation Workbench & Traceability',
      f1Desc:
        'Unify image, video, audio, and chat sessions with <code>@</code> asset refs and <code>/</code> presets. The task center separates active runs from paused/auth-blocked items so polling never triggers duplicate billing.',
      f2Title: 'Infinite Node Canvas',
      f2Desc:
        'Connect text, media, generation, storyboard, panorama, and Director nodes with a floating camera modal, 9-way mouse bindings, and non-destructive derived copies.',
      f3Title: '3D Director Studio & Previs',
      f3Desc:
        'Block actors, props, lights, and cameras in 3D or panorama scenes with ground paths, timeline keyframes, 4-view canvas return, and an experimental Stage Agent.',
      f4Title: 'Three Scoped Agents & Local Knowledge Base',
      f4Desc:
        'Home, Canvas, and Stage assistants stay within strict tool sandboxes (no arbitrary shell access), backed by approval cards, 96-call budgets, resume-on-failure, and Obsidian-compatible local Markdown folders.',
      f5Title: 'Multi-Provider Channels, Relays & ComfyUI',
      f5Desc:
        'Onboard providers via protocol templates, LLM-parsed API docs, or pasted config JSON. Separate free model-list fetches from billable test runs, analyze ComfyUI workflows, use Dreamina CLI, and isolate API keys in macOS Keychain or Windows Credential Manager.',
      galTitle: 'Real Desktop Footage',
      galSub:
        'Click any card to open the media viewer (press Esc or click outside to close). Demos use local test assets and mock responses to show authentic desktop flows.',
      galAll: 'All',
      galGif: 'Motion GIFs',
      galStatic: 'Screenshots',
      g1T: 'Channels & Model Plaza',
      g1D: 'Filter by modality, switch views, inspect parameter schemas',
      g2T: 'Workbench & Submission Trace',
      g2D: 'Inspect exact model, parameters, and prompt snapshots',
      g3T: 'Agent Approval Flow',
      g3D: 'Review planned tool actions before approving or rejecting',
      g4T: 'Resizable Workspace & Projects',
      g4D: 'Drag splitters, double-click to reset, assign sessions',
      g5T: 'Stage Agent Test (Experimental)',
      g5D: '2026-11-07 user test: architecture & 15s multi-shot timeline',
      g6T: '3D Previs & Keyframe Timeline',
      g6D: 'Ground trajectories, follow camera & live PiP preview',
      dlTitle: 'Download for Desktop — Free & Open Source',
      dlSub: 'Your OS is highlighted below. Always download official desktop installers from GitHub Releases.',
      osUniversal: 'Apple Silicon & Intel',
      osRecommended: 'Recommended',
      macHint: 'macOS 11.0+ · Unsigned build: allow in System Settings → Privacy & Security on first launch',
      winHint: 'Windows x64 · Install Microsoft Edge WebView2 Runtime if prompted',
      dlAllReleases: 'All releases & changelogs ↗',
      dlDocs: 'Read full documentation ↗',
      honestTitle: 'Known Boundaries Upfront',
      honest1:
        '<strong>macOS Signing:</strong> Currently ad-hoc signed; macOS Keychain may prompt again per credential after upgrading.',
      honest2:
        '<strong>Experimental Agents:</strong> Built-in and Stage Agents are actively evolving; third-party relay tool protocols may vary.',
      honest3:
        '<strong>Local Data & Billing:</strong> Projects stay local; generation calls go to your configured providers under their pricing and terms.',
      qqLabel: 'Chinese Community QQ Group',
      copyQq: 'Copy ID',
      copiedQq: 'Copied ✓',
      footerAttr:
        'Continued development fork of <a href="https://github.com/henjicc/Storyboard-Copilot" target="_blank" rel="noopener noreferrer">henjicc / 痕继痕迹 — Storyboard-Copilot</a> with written authorization · New code licensed under MIT.',
    },
  };

  let currentLang = localStorage.getItem('osc-site-lang') ||
    (navigator.language && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
  if (!I18N[currentLang]) currentLang = 'zh';

  const detectedOS = (() => {
    const ua = navigator.userAgent || '';
    if (/Mac|iPhone|iPad/i.test(ua)) return 'mac';
    if (/Win/i.test(ua)) return 'win';
    return 'other';
  })();

  function applyLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('osc-site-lang', lang);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    const dict = I18N[lang];

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!dict[key]) return;
      if (dict[key].includes('<')) {
        el.innerHTML = dict[key];
      } else {
        el.textContent = dict[key];
      }
    });

    const langLabel = document.getElementById('lang-label');
    if (langLabel) langLabel.textContent = lang === 'zh' ? 'EN' : '中文';

    // Update OS-aware hero download label & recommended card badge
    const heroDlLabel = document.getElementById('hero-download-label');
    const dlMac = document.getElementById('dl-mac');
    const dlWin = document.getElementById('dl-win');
    const badgeMac = document.getElementById('badge-mac');
    const badgeWin = document.getElementById('badge-win');

    if (detectedOS === 'mac') {
      if (heroDlLabel) heroDlLabel.textContent = dict.heroCtaDownloadMac;
      dlMac?.classList.add('is-recommended');
      if (badgeMac) badgeMac.textContent = `${dict.osRecommended} · Universal`;
    } else if (detectedOS === 'win') {
      if (heroDlLabel) heroDlLabel.textContent = dict.heroCtaDownloadWin;
      dlWin?.classList.add('is-recommended');
      if (badgeWin) badgeWin.textContent = `${dict.osRecommended} · x64`;
    } else if (heroDlLabel) {
      heroDlLabel.textContent = dict.heroCtaDownload;
    }

    // Update playground pause/resume label
    updatePlayMotionLabel();
  }

  /* ------------------------------------------------------------------------
     2. Top Nav Scroll State, CinemaScope 2.39:1 Toggle & Copy QQ
  ------------------------------------------------------------------------ */
  const topNav = document.getElementById('top-nav');
  const scopeToggle = document.getElementById('scope-toggle');
  const hudRatio = document.getElementById('hud-ratio');
  const hudTc = document.getElementById('hud-tc');
  const hudScene = document.getElementById('hud-scene');
  const hudLens = document.getElementById('hud-lens');

  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    topNav?.classList.toggle('is-scrolled', y > 24);

    // Update live cinema timecode based on scroll progress (24fps feel)
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const ratio = Math.min(1, Math.max(0, y / maxScroll));
    const totalFrames = Math.floor(ratio * 24 * 60); // 60s virtual reel
    const mins = Math.floor(totalFrames / (24 * 60));
    const secs = Math.floor((totalFrames / 24) % 60);
    const frames = totalFrames % 24;
    const pad = (n) => String(n).padStart(2, '0');
    if (hudTc) hudTc.textContent = `TC 00:${pad(mins)}:${pad(secs)}:${pad(frames)}`;
  }, { passive: true });

  scopeToggle?.addEventListener('click', () => {
    const active = document.body.classList.toggle('is-cinemascope');
    scopeToggle.classList.toggle('is-active', active);
    scopeToggle.setAttribute('aria-pressed', String(active));
    if (hudRatio) hudRatio.textContent = active ? '2.39:1' : '16:9';
  });

  document.getElementById('lang-toggle')?.addEventListener('click', () => {
    applyLanguage(currentLang === 'zh' ? 'en' : 'zh');
  });

  const copyQqBtn = document.getElementById('copy-qq-btn');
  copyQqBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('1025837759');
      copyQqBtn.textContent = I18N[currentLang].copiedQq;
      setTimeout(() => {
        copyQqBtn.textContent = I18N[currentLang].copyQq;
      }, 2000);
    } catch {
      window.prompt('QQ Group:', '1025837759');
    }
  });

  /* ------------------------------------------------------------------------
     3. Spotlight Cursor Glow & Subtle Hero 3D Tilt
  ------------------------------------------------------------------------ */
  if (!prefersReducedMotion) {
    document.querySelectorAll('.spotlight').forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
        card.style.setProperty('--my', `${e.clientY - rect.top}px`);
      });
    });

    const tiltWrap = document.getElementById('hero-tilt-wrap');
    const tiltCard = document.getElementById('hero-tilt-card');
    if (tiltWrap && tiltCard) {
      tiltWrap.addEventListener('pointermove', (e) => {
        const rect = tiltWrap.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width - 0.5;
        const ny = (e.clientY - rect.top) / rect.height - 0.5;
        tiltCard.style.transform = `rotateY(${nx * 8}deg) rotateX(${-ny * 6}deg) translateZ(6px)`;
      });
      tiltWrap.addEventListener('pointerleave', () => {
        tiltCard.style.transform = 'rotateY(0deg) rotateX(0deg) translateZ(0px)';
      });
    }
  }

  /* ------------------------------------------------------------------------
     4. Hero Atmospheric 3D Perspective Node-Graph Canvas (Auto-Pauses Offscreen)
  ------------------------------------------------------------------------ */
  function initHeroCanvas() {
    const canvas = document.getElementById('hero-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let visible = true;
    let rafId = 0;
    let mouseX = 0;
    let mouseY = 0;
    let smoothX = 0;
    let smoothY = 0;

    const nodes = [
      { x: -3.2, y: 1.0, z: 0.4, color: '#5ce1c6', label: 'SCRIPT' },
      { x: -1.4, y: 1.5, z: 1.8, color: '#38bdf8', label: 'GEN' },
      { x: 0.6, y: 0.7, z: 0.8, color: '#a78bfa', label: 'CANVAS' },
      { x: 2.6, y: 1.3, z: 2.1, color: '#5ce1c6', label: '3D STAGE' },
      { x: 1.8, y: -0.3, z: 3.4, color: '#38bdf8', label: '4-VIEW' },
      { x: -2.2, y: -0.4, z: 2.9, color: '#a78bfa', label: 'AGENT' },
      { x: 3.8, y: 0.2, z: 1.2, color: '#5ce1c6', label: 'CHANNEL' },
    ];
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 4], [5, 1], [5, 2], [2, 6], [4, 2],
    ];

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function project(x, y, z, camX, camY, camZ) {
      const dx = x - camX;
      const dy = y - camY;
      const dz = z - camZ;
      if (dz <= 0.4) return null;
      const focal = Math.min(width, height) * 0.85;
      return {
        sx: width * 0.5 + (dx / dz) * focal,
        sy: height * 0.54 - (dy / dz) * focal,
        scale: focal / dz,
        depth: dz,
      };
    }

    function render(timeMs) {
      if (!visible) {
        rafId = 0;
        return;
      }
      const t = timeMs * 0.00045;
      smoothX += (mouseX - smoothX) * 0.05;
      smoothY += (mouseY - smoothY) * 0.05;

      ctx.clearRect(0, 0, width, height);

      const camX = Math.sin(t * 0.8) * 0.55 + smoothX * 0.65;
      const camY = 1.35 + Math.cos(t * 0.6) * 0.14 - smoothY * 0.32;
      const camZ = -4.2 + Math.min(1.1, window.scrollY * 0.0012);

      // Subtle 3D perspective studio floor grid
      ctx.lineWidth = 1;
      for (let gx = -6; gx <= 6; gx++) {
        const p1 = project(gx, -1.6, -1, camX, camY, camZ);
        const p2 = project(gx, -1.6, 8, camX, camY, camZ);
        if (p1 && p2) {
          ctx.strokeStyle = gx === 0 ? 'rgba(92, 225, 198, 0.16)' : 'rgba(148, 163, 184, 0.065)';
          ctx.beginPath();
          ctx.moveTo(p1.sx, p1.sy);
          ctx.lineTo(p2.sx, p2.sy);
          ctx.stroke();
        }
      }
      for (let gz = 0; gz <= 8; gz++) {
        const p1 = project(-6, -1.6, gz, camX, camY, camZ);
        const p2 = project(6, -1.6, gz, camX, camY, camZ);
        if (p1 && p2) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
          ctx.beginPath();
          ctx.moveTo(p1.sx, p1.sy);
          ctx.lineTo(p2.sx, p2.sy);
          ctx.stroke();
        }
      }

      // Project floating storyboard nodes
      const projected = nodes.map((n, i) => {
        const bob = prefersReducedMotion ? 0 : Math.sin(t * 2.2 + i * 1.1) * 0.12;
        return {
          node: n,
          p: project(n.x, n.y + bob, n.z + 1.8, camX, camY, camZ),
        };
      });

      // Edges + light pulses
      edges.forEach(([aIdx, bIdx], ei) => {
        const a = projected[aIdx].p;
        const b = projected[bIdx].p;
        if (!a || !b) return;
        const mx = (a.sx + b.sx) * 0.5;
        const my = (a.sy + b.sy) * 0.5 - 24;

        ctx.strokeStyle = 'rgba(92, 225, 198, 0.14)';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.quadraticCurveTo(mx, my, b.sx, b.sy);
        ctx.stroke();

        if (!prefersReducedMotion) {
          const u = (t * 0.75 + ei * 0.17) % 1;
          const inv = 1 - u;
          const px = inv * inv * a.sx + 2 * inv * u * mx + u * u * b.sx;
          const py = inv * inv * a.sy + 2 * inv * u * my + u * u * b.sy;
          ctx.fillStyle = 'rgba(92, 225, 198, 0.65)';
          ctx.beginPath();
          ctx.arc(px, py, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      // Draw glowing node rings
      projected.forEach(({ node, p }) => {
        if (!p) return;
        const r = Math.max(3, Math.min(7, p.scale * 0.032));
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r * 2.1, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(92, 225, 198, 0.08)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#070e18';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = node.color;
        ctx.stroke();
      });

      if (!prefersReducedMotion) {
        rafId = requestAnimationFrame(render);
      }
    }

    window.addEventListener('pointermove', (e) => {
      mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
      mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });

    window.addEventListener('resize', resize);
    resize();

    const observer = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible && !rafId) {
        rafId = requestAnimationFrame(render);
      }
    }, { threshold: 0.02 });
    observer.observe(canvas);

    rafId = requestAnimationFrame(render);
  }

  /* ------------------------------------------------------------------------
     5. GSAP Opening Shot & ScrollTrigger 4-Act Cinema Camera Sequence
  ------------------------------------------------------------------------ */
  const ACT_META = [
    {
      move: 'DOLLY IN',
      focal: '24mm',
      hudScene: 'SCENE 01 · DOLLY IN',
      stageTransform: { rotateY: -4, rotateX: 2.5, scale: 0.96, y: 8 },
    },
    {
      move: 'TRACKING PAN',
      focal: '35mm',
      hudScene: 'SCENE 02 · TRACKING PAN',
      stageTransform: { rotateY: 4.5, rotateX: -1.5, scale: 1.0, y: 0 },
    },
    {
      move: '3D ORBIT',
      focal: '50mm',
      hudScene: 'SCENE 03 · 3D ORBIT',
      stageTransform: { rotateY: -5.5, rotateX: 3.5, scale: 1.03, y: -4 },
    },
    {
      move: 'LOCK-ON',
      focal: '85mm',
      hudScene: 'SCENE 04 · LOCK-ON',
      stageTransform: { rotateY: 0, rotateX: 0, scale: 1.01, y: 0 },
    },
  ];

  let activeAct = 0;
  let seqTrigger = null;

  function setCinemaAct(idx, animateStage = true) {
    const clamped = Math.max(0, Math.min(ACT_META.length - 1, idx));
    activeAct = clamped;
    const meta = ACT_META[clamped];

    document.querySelectorAll('.beat-card').forEach((card, i) => {
      card.classList.toggle('is-active', i === clamped);
    });
    document.querySelectorAll('.cinema-frame').forEach((frame, i) => {
      frame.classList.toggle('is-active', i === clamped);
    });
    document.querySelectorAll('.tl-tab').forEach((tab, i) => {
      const isCurrent = i === clamped;
      tab.classList.toggle('is-active', isCurrent);
      tab.setAttribute('aria-selected', String(isCurrent));
    });

    const rigMove = document.getElementById('rig-move');
    const rigFocal = document.getElementById('rig-focal');
    const rigAct = document.getElementById('rig-act');
    if (rigMove) rigMove.textContent = meta.move;
    if (rigFocal) rigFocal.textContent = meta.focal;
    if (rigAct) rigAct.textContent = `0${clamped + 1} / 04`;

    if (hudScene) hudScene.textContent = meta.hudScene;
    if (hudLens) hudLens.textContent = meta.focal;

    const stage3d = document.getElementById('cinema-stage-3d');
    if (stage3d && animateStage && !prefersReducedMotion) {
      const tf = meta.stageTransform;
      if (window.gsap) {
        window.gsap.to(stage3d, {
          rotateY: tf.rotateY,
          rotateX: tf.rotateX,
          scale: tf.scale,
          y: tf.y,
          duration: 0.75,
          ease: 'power3.out',
          overwrite: 'auto',
        });
      } else {
        stage3d.style.transform = `rotateY(${tf.rotateY}deg) rotateX(${tf.rotateX}deg) scale(${tf.scale}) translateY(${tf.y}px)`;
      }
    }
  }

  function initGsapCinema() {
    const progressEl = document.getElementById('timeline-progress');

    // Timeline tab click handler (works on both desktop ScrollTrigger and mobile)
    document.querySelectorAll('[data-jump-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-jump-act'));
        if (seqTrigger && window.innerWidth > 1060 && !prefersReducedMotion) {
          const targetProgress = (idx + 0.12) / ACT_META.length;
          const scrollTarget = seqTrigger.start + (seqTrigger.end - seqTrigger.start) * targetProgress;
          window.scrollTo({ top: scrollTarget, behavior: 'smooth' });
        } else {
          setCinemaAct(idx);
          if (progressEl) progressEl.style.width = `${((idx + 1) / ACT_META.length) * 100}%`;
        }
      });
    });

    if (!window.gsap || prefersReducedMotion) {
      setCinemaAct(0, false);
      return;
    }

    const gsap = window.gsap;
    if (window.ScrollTrigger) {
      gsap.registerPlugin(window.ScrollTrigger);
    }

    // Opening Cinema Push-In (immediate visibility, crisp motion, settles quietly)
    gsap.from('.hero-enter', {
      y: 16,
      duration: 0.65,
      stagger: 0.05,
      ease: 'power3.out',
      clearProps: 'transform',
    });

    gsap.from('#hero-tilt-card', {
      scale: 0.95,
      rotateX: 3.5,
      duration: 0.85,
      ease: 'power3.out',
      clearProps: 'transform',
    });

    if (!window.ScrollTrigger) {
      setCinemaAct(0, false);
      return;
    }

    const ScrollTrigger = window.ScrollTrigger;

    // 1. Pinned 4-Act Cinema Camera Sequence on desktop viewports
    if (window.innerWidth > 1060) {
      seqTrigger = ScrollTrigger.create({
        id: 'cinema-sequence-pin',
        trigger: '#cinema-sequence',
        start: 'top top',
        end: '+=2200',
        pin: '#cinema-pinned',
        scrub: 0.65,
        anticipatePin: 1,
        onUpdate: (self) => {
          const p = self.progress;
          if (progressEl) {
            progressEl.style.width = `${Math.max(8, p * 100)}%`;
          }
          const idx = Math.min(ACT_META.length - 1, Math.floor(p * ACT_META.length));
          if (idx !== activeAct) {
            setCinemaAct(idx, true);
          }
        },
        onLeaveBack: () => {
          if (hudScene) hudScene.textContent = 'SCENE 01 · WIDE';
          if (hudLens) hudLens.textContent = '24mm';
        },
      });
    } else {
      setCinemaAct(0, false);
    }

    // 2. Clean batched entrance for Bento cards & Gallery items (never stuck hidden)
    ScrollTrigger.batch('.bento-card, .gallery-card', {
      start: 'top 90%',
      once: true,
      onEnter: (batch) => {
        gsap.fromTo(
          batch,
          { y: 18, opacity: 0.65 },
          {
            y: 0,
            opacity: 1,
            duration: 0.55,
            stagger: 0.05,
            ease: 'power3.out',
            clearProps: 'transform,opacity',
          }
        );
      },
    });

    // Refresh after images settle
    window.addEventListener('load', () => ScrollTrigger.refresh());
  }

  /* ------------------------------------------------------------------------
     6. Interactive 3D Director Stage & Live PiP Monitor (Auto-Pauses Offscreen)
  ------------------------------------------------------------------------ */
  let stagePlaying = !prefersReducedMotion;

  function updatePlayMotionLabel() {
    const icon = document.getElementById('play-motion-icon');
    const text = document.getElementById('play-motion-text');
    if (icon) icon.textContent = stagePlaying ? '⏸' : '▶';
    if (text) text.textContent = stagePlaying ? I18N[currentLang].playPause : I18N[currentLang].playResume;
  }

  function initDirectorPlayground() {
    const mainCanvas = document.getElementById('director-stage-canvas');
    const pipCanvas = document.getElementById('director-pip-canvas');
    if (!mainCanvas || !pipCanvas) return;

    const ctx = mainCanvas.getContext('2d');
    const pipCtx = pipCanvas.getContext('2d');
    if (!ctx || !pipCtx) return;

    const statusEl = document.getElementById('play-status');
    const timeLabel = document.getElementById('play-time-label');
    const slider = document.getElementById('play-timeline-slider');
    const pipFocal = document.getElementById('pip-focal');
    const pipAngle = document.getElementById('pip-angle');
    const toggleBtn = document.getElementById('play-toggle-motion');

    // Outer observer camera (orbitable by user drag)
    const viewCam = { yaw: 0.65, pitch: 0.44, dist: 12.2, targetYaw: 0.65, targetPitch: 0.44, targetDist: 12.2 };

    // Virtual cinema camera rig (flies smoothly between presets & drives PiP monitor)
    const rigCam = {
      yaw: 0.42,
      pitch: 0.24,
      dist: 7.4,
      focal: 24,
      targetYaw: 0.42,
      targetPitch: 0.24,
      targetDist: 7.4,
      targetFocal: 24,
      preset: 'wide',
      shutterFlash: 0,
    };

    const PRESETS = {
      wide: { yaw: 0.42, pitch: 0.24, dist: 7.6, focal: 24, labelZh: '24mm · 建立广角', labelEn: '24mm · Wide Establishing' },
      dolly: { yaw: 0.08, pitch: 0.14, dist: 3.9, focal: 50, labelZh: '50mm · 推轨特写', labelEn: '50mm · Dolly Close-Up' },
      orbit: { yaw: 0.0, pitch: 0.28, dist: 6.2, focal: 35, labelZh: '35mm · 360° 环绕', labelEn: '35mm · 360° Orbit' },
      crane: { yaw: 0.78, pitch: 0.92, dist: 8.6, focal: 28, labelZh: '28mm · 摇臂俯拍', labelEn: '28mm · Crane High Angle' },
      fourview: { yaw: 0.0, pitch: 0.22, dist: 6.0, focal: 35, labelZh: '四视图 · 自动轮切', labelEn: '4-View · Multi-Angle Cycle' },
    };

    let stageVisible = false;
    let rafId = 0;
    let simTime = 0; // 0..12 seconds
    let lastTs = performance.now();
    let isDragging = false;
    let lastPointerX = 0;
    let lastPointerY = 0;
    let fourViewStep = 0;
    let fourViewTimer = 0;

    function resizeMain() {
      const rect = mainCanvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      mainCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
      mainCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function selectPreset(name) {
      const p = PRESETS[name] || PRESETS.wide;
      rigCam.preset = name;
      rigCam.targetYaw = p.yaw;
      rigCam.targetPitch = p.pitch;
      rigCam.targetDist = p.dist;
      rigCam.targetFocal = p.focal;
      if (name === 'crane') {
        viewCam.targetPitch = 0.68;
      } else {
        viewCam.targetPitch = 0.44;
      }
      document.querySelectorAll('[data-cam-preset]').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-cam-preset') === name);
      });
      if (statusEl) statusEl.textContent = currentLang === 'zh' ? p.labelZh : p.labelEn;
      if (pipFocal) pipFocal.textContent = `${p.focal}mm`;
    }

    document.querySelectorAll('[data-cam-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectPreset(btn.getAttribute('data-cam-preset'));
      });
    });

    toggleBtn?.addEventListener('click', () => {
      stagePlaying = !stagePlaying;
      updatePlayMotionLabel();
    });

    slider?.addEventListener('input', () => {
      simTime = (Number(slider.value) / 1000) * 12;
      if (timeLabel) timeLabel.textContent = `${simTime.toFixed(1).padStart(4, '0')}s / 12.0s`;
    });

    // Pointer drag orbit on stage canvas (does NOT hijack page vertical scroll!)
    mainCanvas.addEventListener('pointerdown', (e) => {
      isDragging = true;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      mainCanvas.setPointerCapture(e.pointerId);
    });
    mainCanvas.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - lastPointerX;
      const dy = e.clientY - lastPointerY;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      viewCam.targetYaw -= dx * 0.007;
      viewCam.targetPitch = Math.max(0.14, Math.min(1.22, viewCam.targetPitch + dy * 0.0055));
    });
    mainCanvas.addEventListener('pointerup', () => { isDragging = false; });
    mainCanvas.addEventListener('pointercancel', () => { isDragging = false; });

    // 3D Camera math helper (right-handed Y-up basis)
    function makeCamera(yaw, pitch, dist, lookY = 0.9) {
      const cx = Math.sin(yaw) * Math.cos(pitch) * dist;
      const cy = Math.sin(pitch) * dist + lookY;
      const cz = Math.cos(yaw) * Math.cos(pitch) * dist;
      const fx = -cx;
      const fy = lookY - cy;
      const fz = -cz;
      const fl = Math.hypot(fx, fy, fz) || 1;
      const fwd = [fx / fl, fy / fl, fz / fl];
      // right = normalize(cross(fwd, [0, 1, 0])) = [-fwd.z, 0, fwd.x]
      const rx = -fwd[2];
      const rz = fwd[0];
      const rl = Math.hypot(rx, rz) || 1;
      const right = [rx / rl, 0, rz / rl];
      // up = cross(right, fwd) -> guaranteed positive Y
      const up = [
        right[1] * fwd[2] - right[2] * fwd[1],
        right[2] * fwd[0] - right[0] * fwd[2],
        right[0] * fwd[1] - right[1] * fwd[0],
      ];
      return { pos: [cx, cy, cz], fwd, right, up };
    }

    function projectPt(pt, cam, w, h, fovScale) {
      const vx = pt[0] - cam.pos[0];
      const vy = pt[1] - cam.pos[1];
      const vz = pt[2] - cam.pos[2];
      const cz = vx * cam.fwd[0] + vy * cam.fwd[1] + vz * cam.fwd[2];
      if (cz <= 0.15) return null;
      const cx = vx * cam.right[0] + vy * cam.right[1] + vz * cam.right[2];
      const cy = vx * cam.up[0] + vy * cam.up[1] + vz * cam.up[2];
      const scale = (h * fovScale) / cz;
      return { x: w * 0.5 + cx * scale, y: h * 0.54 - cy * scale, z: cz, s: scale };
    }

    function getActorPositions(tSec) {
      // 12s blocking loop: two actors walk from left & right toward center stairs, meet, then reset gently
      const phase = Math.min(1, tSec / 7.5);
      const ease = phase < 0.5 ? 2 * phase * phase : 1 - Math.pow(-2 * phase + 2, 2) / 2;
      const aX = -3.4 + ease * 2.55;
      const aZ = 0.65 - Math.sin(ease * Math.PI) * 0.55;
      const bX = 3.4 - ease * 2.55;
      const bZ = 0.65 + Math.sin(ease * Math.PI) * 0.35;
      return {
        a: [aX, 0, aZ],
        b: [bX, 0, bZ],
      };
    }

    function drawBoxWire(targetCtx, cam, w, h, fov, cx, cy, cz, sx, sy, sz, stroke, fill) {
      const hx = sx / 2, hy = sy / 2, hz = sz / 2;
      const verts = [
        [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
        [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
        [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
        [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
      ].map((v) => projectPt(v, cam, w, h, fov));
      if (verts.some((v) => !v)) return;

      const faces = [
        [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6],
      ];
      if (fill) {
        targetCtx.fillStyle = fill;
        faces.forEach((f) => {
          targetCtx.beginPath();
          targetCtx.moveTo(verts[f[0]].x, verts[f[0]].y);
          for (let i = 1; i < f.length; i++) targetCtx.lineTo(verts[f[i]].x, verts[f[i]].y);
          targetCtx.closePath();
          targetCtx.fill();
        });
      }
      const edgesIdx = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      targetCtx.strokeStyle = stroke;
      targetCtx.lineWidth = 1;
      edgesIdx.forEach(([i, j]) => {
        targetCtx.beginPath();
        targetCtx.moveTo(verts[i].x, verts[i].y);
        targetCtx.lineTo(verts[j].x, verts[j].y);
        targetCtx.stroke();
      });
    }

    function drawActor(targetCtx, cam, w, h, fov, pos, color, label) {
      const feet = projectPt([pos[0], 0, pos[2]], cam, w, h, fov);
      const torso = projectPt([pos[0], 1.12, pos[2]], cam, w, h, fov);
      const head = projectPt([pos[0], 1.62, pos[2]], cam, w, h, fov);
      if (!feet || !torso || !head) return;

      // Ground ring
      targetCtx.strokeStyle = color;
      targetCtx.lineWidth = 1.6;
      targetCtx.beginPath();
      targetCtx.ellipse(feet.x, feet.y, Math.max(5, feet.s * 0.28), Math.max(2.5, feet.s * 0.12), 0, 0, Math.PI * 2);
      targetCtx.stroke();

      // Stylized mannequin body
      targetCtx.strokeStyle = color;
      targetCtx.lineWidth = Math.max(2.2, feet.s * 0.1);
      targetCtx.lineCap = 'round';
      targetCtx.beginPath();
      targetCtx.moveTo(feet.x, feet.y);
      targetCtx.lineTo(torso.x, torso.y);
      targetCtx.stroke();

      // Head
      targetCtx.fillStyle = color;
      targetCtx.beginPath();
      targetCtx.arc(head.x, head.y, Math.max(3.5, head.s * 0.14), 0, Math.PI * 2);
      targetCtx.fill();

      if (label && w > 420) {
        targetCtx.font = '600 11px ui-monospace, Menlo, monospace';
        targetCtx.fillStyle = '#e2e8f0';
        targetCtx.fillText(label, head.x - 18, head.y - 12);
      }
    }

    function renderScene(targetCtx, cam, w, h, fov, actors, showRig) {
      targetCtx.clearRect(0, 0, w, h);

      // Subtle horizon glow
      const bgGrad = targetCtx.createRadialGradient(w * 0.5, h * 0.45, 20, w * 0.5, h * 0.5, w * 0.72);
      bgGrad.addColorStop(0, '#101d2f');
      bgGrad.addColorStop(1, '#050911');
      targetCtx.fillStyle = bgGrad;
      targetCtx.fillRect(0, 0, w, h);

      // 3D Floor Grid
      targetCtx.lineWidth = 1;
      for (let i = -5; i <= 5; i++) {
        const a = projectPt([i, 0, -5], cam, w, h, fov);
        const b = projectPt([i, 0, 5], cam, w, h, fov);
        if (a && b) {
          targetCtx.strokeStyle = i === 0 ? 'rgba(92, 225, 198, 0.25)' : 'rgba(148, 163, 184, 0.1)';
          targetCtx.beginPath();
          targetCtx.moveTo(a.x, a.y);
          targetCtx.lineTo(b.x, b.y);
          targetCtx.stroke();
        }
        const c = projectPt([-5, 0, i], cam, w, h, fov);
        const d = projectPt([5, 0, i], cam, w, h, fov);
        if (c && d) {
          targetCtx.strokeStyle = i === 0 ? 'rgba(56, 189, 248, 0.22)' : 'rgba(148, 163, 184, 0.1)';
          targetCtx.beginPath();
          targetCtx.moveTo(c.x, c.y);
          targetCtx.lineTo(d.x, d.y);
          targetCtx.stroke();
        }
      }

      // Architecture props (steps + twin pillars echoing the real 3D stage)
      drawBoxWire(targetCtx, cam, w, h, fov, 0, 0.22, -1.6, 3.2, 0.44, 1.3, 'rgba(148, 163, 184, 0.34)', 'rgba(30, 41, 59, 0.45)');
      drawBoxWire(targetCtx, cam, w, h, fov, -2.0, 1.45, -2.3, 0.55, 2.9, 0.55, 'rgba(148, 163, 184, 0.36)', 'rgba(30, 41, 59, 0.5)');
      drawBoxWire(targetCtx, cam, w, h, fov, 2.0, 1.45, -2.3, 0.55, 2.9, 0.55, 'rgba(148, 163, 184, 0.36)', 'rgba(30, 41, 59, 0.5)');
      drawBoxWire(targetCtx, cam, w, h, fov, 0, 2.95, -2.3, 4.7, 0.42, 0.65, 'rgba(92, 225, 198, 0.28)', 'rgba(20, 35, 52, 0.55)');

      // Ground blocking trajectory paths (dashed)
      targetCtx.save();
      targetCtx.setLineDash([5, 5]);
      targetCtx.lineWidth = 1.6;
      ['a', 'b'].forEach((key) => {
        targetCtx.strokeStyle = key === 'a' ? 'rgba(251, 191, 36, 0.6)' : 'rgba(167, 139, 250, 0.65)';
        targetCtx.beginPath();
        let started = false;
        for (let s = 0; s <= 24; s++) {
          const sample = getActorPositions((s / 24) * 7.5)[key];
          const p = projectPt([sample[0], 0.03, sample[2]], cam, w, h, fov);
          if (!p) continue;
          if (!started) {
            targetCtx.moveTo(p.x, p.y);
            started = true;
          } else {
            targetCtx.lineTo(p.x, p.y);
          }
        }
        targetCtx.stroke();
      });
      targetCtx.restore();

      // Actors
      drawActor(targetCtx, cam, w, h, fov, actors.a, '#fbbf24', 'ACTOR A');
      drawActor(targetCtx, cam, w, h, fov, actors.b, '#a78bfa', 'ACTOR B');

      // Virtual Cinema Camera Rig & Glowing Frustum (only drawn in outer viewport)
      if (showRig) {
        const rigCameraObj = makeCamera(rigCam.yaw, rigCam.pitch, rigCam.dist, 0.9);
        const rp = rigCameraObj.pos;
        const rigScreen = projectPt(rp, cam, w, h, fov);
        const targetScreen = projectPt([0, 0.95, 0.4], cam, w, h, fov);

        if (rigScreen && targetScreen) {
          // Sightline
          targetCtx.save();
          targetCtx.setLineDash([4, 4]);
          targetCtx.strokeStyle = 'rgba(92, 225, 198, 0.55)';
          targetCtx.lineWidth = 1.25;
          targetCtx.beginPath();
          targetCtx.moveTo(rigScreen.x, rigScreen.y);
          targetCtx.lineTo(targetScreen.x, targetScreen.y);
          targetCtx.stroke();
          targetCtx.restore();

          // Frustum pyramid corners in front of camera
          const d = 1.45;
          const halfW = 0.68 * (28 / rigCam.focal);
          const halfH = halfW * 0.56;
          const fCorners = [
            [-halfW, halfH], [halfW, halfH], [halfW, -halfH], [-halfW, -halfH],
          ].map(([ox, oy]) => [
            rp[0] + rigCameraObj.fwd[0] * d + rigCameraObj.right[0] * ox + rigCameraObj.up[0] * oy,
            rp[1] + rigCameraObj.fwd[1] * d + rigCameraObj.right[1] * ox + rigCameraObj.up[1] * oy,
            rp[2] + rigCameraObj.fwd[2] * d + rigCameraObj.right[2] * ox + rigCameraObj.up[2] * oy,
          ]).map((pt) => projectPt(pt, cam, w, h, fov));

          if (fCorners.every(Boolean)) {
            targetCtx.strokeStyle = 'rgba(92, 225, 198, 0.85)';
            targetCtx.fillStyle = 'rgba(92, 225, 198, 0.08)';
            targetCtx.lineWidth = 1.4;
            targetCtx.beginPath();
            targetCtx.moveTo(fCorners[0].x, fCorners[0].y);
            fCorners.forEach((c) => targetCtx.lineTo(c.x, c.y));
            targetCtx.closePath();
            targetCtx.fill();
            targetCtx.stroke();

            fCorners.forEach((c) => {
              targetCtx.beginPath();
              targetCtx.moveTo(rigScreen.x, rigScreen.y);
              targetCtx.lineTo(c.x, c.y);
              targetCtx.stroke();
            });
          }

          // Camera body dot
          targetCtx.fillStyle = '#5ce1c6';
          targetCtx.beginPath();
          targetCtx.arc(rigScreen.x, rigScreen.y, 6, 0, Math.PI * 2);
          targetCtx.fill();
          targetCtx.font = '700 11px ui-monospace, Menlo, monospace';
          targetCtx.fillStyle = '#5ce1c6';
          targetCtx.fillText(`CAM · ${Math.round(rigCam.focal)}mm`, rigScreen.x + 10, rigScreen.y - 8);
        }
      }
    }

    function tick(now) {
      if (!stageVisible) {
        rafId = 0;
        return;
      }
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;

      if (stagePlaying) {
        simTime = (simTime + dt) % 12;
        if (slider) slider.value = String(Math.round((simTime / 12) * 1000));
        if (timeLabel) timeLabel.textContent = `${simTime.toFixed(1).padStart(4, '0')}s / 12.0s`;
      }

      // Dynamic camera preset behaviors
      if (rigCam.preset === 'orbit') {
        rigCam.targetYaw += dt * 0.55;
      } else if (rigCam.preset === 'dolly') {
        rigCam.targetDist = 3.6 + Math.sin(simTime * 0.52) * 0.9;
      } else if (rigCam.preset === 'fourview') {
        fourViewTimer += dt;
        if (fourViewTimer >= 1.65) {
          fourViewTimer = 0;
          fourViewStep = (fourViewStep + 1) % 4;
          rigCam.targetYaw = fourViewStep * (Math.PI / 2) + 0.25;
          rigCam.targetPitch = fourViewStep === 2 ? 0.55 : 0.22;
          rigCam.shutterFlash = 1;
        }
      }

      // Smooth damped interpolation
      const damp = 1 - Math.exp(-dt * 6.5);
      viewCam.yaw += (viewCam.targetYaw - viewCam.yaw) * damp;
      viewCam.pitch += (viewCam.targetPitch - viewCam.pitch) * damp;
      viewCam.dist += (viewCam.targetDist - viewCam.dist) * damp;

      rigCam.yaw += (rigCam.targetYaw - rigCam.yaw) * damp;
      rigCam.pitch += (rigCam.targetPitch - rigCam.pitch) * damp;
      rigCam.dist += (rigCam.targetDist - rigCam.dist) * damp;
      rigCam.focal += (rigCam.targetFocal - rigCam.focal) * damp;
      rigCam.shutterFlash = Math.max(0, rigCam.shutterFlash - dt * 3.2);

      const actors = getActorPositions(simTime);
      const mainRect = mainCanvas.getBoundingClientRect();
      const outerCamObj = makeCamera(viewCam.yaw, viewCam.pitch, viewCam.dist, 0.85);
      renderScene(ctx, outerCamObj, mainRect.width, mainRect.height, 0.95, actors, true);

      // Render Live PiP Lens Monitor from the virtual camera rig's exact viewpoint
      const rigCamObj = makeCamera(rigCam.yaw, rigCam.pitch, rigCam.dist, 0.95);
      const lensFov = 0.72 * (rigCam.focal / 24);
      renderScene(pipCtx, rigCamObj, pipCanvas.width, pipCanvas.height, lensFov, actors, false);

      // Rule of thirds + shutter flash on PiP
      pipCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      pipCtx.lineWidth = 1;
      [pipCanvas.width / 3, (pipCanvas.width * 2) / 3].forEach((x) => {
        pipCtx.beginPath();
        pipCtx.moveTo(x, 0);
        pipCtx.lineTo(x, pipCanvas.height);
        pipCtx.stroke();
      });
      if (rigCam.shutterFlash > 0.02) {
        pipCtx.fillStyle = `rgba(92, 225, 198, ${rigCam.shutterFlash * 0.35})`;
        pipCtx.fillRect(0, 0, pipCanvas.width, pipCanvas.height);
      }

      if (pipAngle) {
        const az = ((Math.round((rigCam.yaw * 180) / Math.PI) % 360) + 360) % 360;
        const el = Math.round((rigCam.pitch * 180) / Math.PI);
        pipAngle.textContent = `AZ ${az}° · EL ${el}°`;
      }

      rafId = requestAnimationFrame(tick);
    }

    window.addEventListener('resize', resizeMain);
    resizeMain();

    const observer = new IntersectionObserver((entries) => {
      stageVisible = entries[0].isIntersecting;
      if (stageVisible && !rafId) {
        lastTs = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    }, { threshold: 0.02 });
    observer.observe(mainCanvas);
  }

  /* ------------------------------------------------------------------------
     7. Gallery Filter & Accessible Unified Lightbox
  ------------------------------------------------------------------------ */
  function initGalleryAndLightbox() {
    document.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const filter = btn.getAttribute('data-filter');
        document.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
        document.querySelectorAll('.gallery-card').forEach((card) => {
          const match = filter === 'all' || card.getAttribute('data-kind') === filter;
          card.classList.toggle('is-hidden', !match);
        });
        if (window.ScrollTrigger) window.ScrollTrigger.refresh();
      });
    });

    const lightbox = document.getElementById('lightbox');
    const lbImg = document.getElementById('lightbox-img');
    const lbCaption = document.getElementById('lightbox-caption');
    const lbClose = document.getElementById('lightbox-close');
    const lbBackdrop = document.getElementById('lightbox-backdrop');
    let lastTrigger = null;

    function openLightbox(src, caption, triggerEl) {
      if (!lightbox || !lbImg || !lbCaption) return;
      lastTrigger = triggerEl || null;
      lbImg.src = src;
      lbImg.alt = caption || '';
      lbCaption.textContent = caption || '';
      lightbox.hidden = false;
      document.body.style.overflow = 'hidden';
      lbClose?.focus();
    }

    function closeLightbox() {
      if (!lightbox) return;
      lightbox.hidden = true;
      document.body.style.overflow = '';
      if (lastTrigger && typeof lastTrigger.focus === 'function') {
        lastTrigger.focus();
      }
    }

    document.querySelectorAll('[data-lightbox-src]').forEach((el) => {
      el.addEventListener('click', () => {
        openLightbox(
          el.getAttribute('data-lightbox-src'),
          el.getAttribute('data-lightbox-caption'),
          el
        );
      });
    });

    lbClose?.addEventListener('click', closeLightbox);
    lbBackdrop?.addEventListener('click', closeLightbox);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox && !lightbox.hidden) {
        closeLightbox();
      }
    });
  }

  /* ------------------------------------------------------------------------
     Boot
  ------------------------------------------------------------------------ */
  document.addEventListener('DOMContentLoaded', () => {
    applyLanguage(currentLang);
    initHeroCanvas();
    initGsapCinema();
    initDirectorPlayground();
    initGalleryAndLightbox();
  });
})();
