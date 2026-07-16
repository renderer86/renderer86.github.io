---
layout: post
title: "UE5 Occlusion Culling: 왜 렌더러는 이전 프레임의 결과값으로 컬링하는가 — visibility와 HZB의 1프레임 지연 렌더링"
icon: paper
permalink: hzb-occlusion
categories: Rendering
tags: [Rendering, UnrealEngine, OcclusionCulling, HZB, Visibility, OcclusionQuery, RenderThread, GPUDriven, Nanite]
excerpt: "언리얼의 render thread는 프레임 맨 앞 InitViews에서 '뭐가 보이나'를 결정한다. 그런데 그 판단에 쓰는 occlusion 결과 — HZB 테스트든 하드웨어 occlusion query든 — 는 전부 이전 프레임에 GPU가 계산한 것이다. 이번 프레임 depth는 아직 그려지지도 않았고, GPU에게 답을 재촉하면 CPU-GPU 파이프라인이 통째로 멈추기 때문이다. UE 5.8 소스를 따라가며 소비가 생산보다 먼저 오는 프레임 타임라인, PendingOcclusionQuery 링버퍼와 FHZBOcclusionTester의 readback 사이클, 'stall을 줄이는 대신 out-of-date 아티팩트를 받아들인다'고 CVar 주석에 명시된 트레이드오프, 그리고 그 지연을 계약으로 만들기 위한 보증 장치들 — 프레임 넘버 검증, 히스토리 폴백, bounds 확장, 4x4 min-depth의 보수성 — 을 코드로 확인한다. 마지막으로 같은 문제를 '기다리지 않고 소비자를 GPU로 옮겨서' 풀어버린 Nanite two-pass occlusion과 대비한다."
img_name: "occlusion-query-core-sketch.webp"
back_color: "#ffffff"
toc: false
show: true
new: true
series: -1
index: 24
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 프로파일러에서 `InitViews`를 보다가 occlusion 결과가 "지난 프레임 것"이라는 말을 듣고 왜 그런지 궁금했던 분
> - 카메라를 홱 돌리면 오브젝트가 한 프레임 늦게 나타나는(popping) 이유를 코드 레벨에서 확인하고 싶은 분
> - `r.HZBOcclusion` 0과 1이 각각 어떤 시스템이고, 둘 다 왜 1프레임 이상 지연되는지 알고 싶은 분
> - "GPU 결과를 CPU가 기다리면 왜 안 되는가"를 파이프라이닝 관점에서 정리하고 싶은 분
> - Nanite의 two-pass occlusion이 기존 방식과 근본적으로 무엇이 다른지 궁금한 분
>
> **이 글로 알 수 있는 내용**
>
> - 프레임 타임라인에서 <strong>소비(InitViews)가 생산(depth → HZB → 테스트)보다 먼저</strong> 온다는 것 — 같은 프레임 소비가 순서상 불가능한 이유
> - 하드웨어 occlusion query 경로의 <code>PendingOcclusionQuery</code> 링버퍼 — 읽기와 쓰기가 같은 슬롯을 쓰는 <code>CurrentFrame % NumBufferedFrames</code> 트릭
> - <code>r.NumBufferedOcclusionQueries</code> 주석에 박제된 설계 트레이드오프 — "stall 확률 감소 vs out-of-date 아티팩트 증가"
> - <code>FHZBOcclusionTester</code>의 1프레임 사이클: MapResults(N-1 결과) → IsVisible → AddBounds → Submit → readback → 다음 프레임
> - 지연을 안전하게 만드는 장치들 — <code>ValidFrameNumber</code>, <code>LagTolerance</code>, <code>WasOccludedLastFrame</code> 폴백, <code>OCCLUSION_SLOP</code>과 bbox 확장 CVar
> - HZB 테스트가 mip 보수 선택 + 4×4 min-depth로 "확실히 가려진 것만 죽이는" 이유
> - Nanite two-pass — CPU readback을 없애고 같은 프레임 안에서 오차를 보정하는 구조와의 정면 대비

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.hzbo-post {
  --surface: #f8fafd;
  --surface2: #edf2f9;
  --border: rgba(14,116,182,0.12);
  --border2: rgba(14,116,182,0.26);
  --text: #16202e;
  --text2: #3f4c60;
  --text3: #8592a6;
  --accent: #0e74b6;
  --accent2: #7248d4;
  --gold: #b07d00;
  --teal: #0a8f72;
  --coral: #d6304a;
}
.hzbo-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.hzbo-post .callout {
  border-radius: 12px;
  padding: 18px 22px;
  margin: 24px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.hzbo-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.hzbo-post .callout-info { background: rgba(14,116,182,0.05); border-color: rgba(14,116,182,0.18); }
.hzbo-post .callout-info::before { background: var(--accent); }
.hzbo-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.hzbo-post .callout-warn::before { background: var(--gold); }
.hzbo-post .callout-purple { background: rgba(114,72,212,0.05); border-color: rgba(114,72,212,0.18); }
.hzbo-post .callout-purple::before { background: var(--accent2); }
.hzbo-post .callout-title {
  font-size: 12px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; margin-bottom: 6px;
}
.hzbo-post .callout-info .callout-title { color: var(--accent); }
.hzbo-post .callout-warn .callout-title { color: var(--gold); }
.hzbo-post .callout-purple .callout-title { color: var(--accent2); }
.hzbo-post .callout p { margin: 0; font-size: 14px; color: var(--text2); line-height: 1.78; }
.hzbo-post .callout p + p { margin-top: 10px; }
.hzbo-post .data-table { overflow-x: auto; margin: 24px 0; }
.hzbo-post .data-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
.hzbo-post .data-table th {
  padding: 10px 14px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--accent);
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
}
.hzbo-post .data-table td { padding: 9px 14px; border: 1px solid var(--border); color: var(--text2); line-height: 1.65; vertical-align: top; }
.hzbo-post .data-table tr:nth-child(even) td { background: var(--surface); }
.hzbo-post .data-table code { font-size: 12px; }
.hzbo-post .code-block {
  background: #101722;
  border: 1px solid rgba(90,160,220,0.16);
  border-radius: 12px;
  padding: 20px 22px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.8;
  overflow-x: auto;
  margin: 20px 0;
  position: relative;
  white-space: pre;
  color: #cfdbea;
}
.hzbo-post .code-block .kw { color: #c4b5fd; }
.hzbo-post .code-block .fn { color: #5eead4; }
.hzbo-post .code-block .cm { color: #64748b; font-style: italic; }
.hzbo-post .code-block .num { color: #fb923c; }
.hzbo-post .code-block .hl { color: #7dd3fc; font-weight: 500; }
.hzbo-post .code-lang {
  position: absolute; top: 10px; right: 14px;
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #64748b;
}
.hzbo-post .scene-fig {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 22px 20px;
  margin: 26px 0;
}
.hzbo-post .scene-fig img { width: 100%; height: auto; display: block; border-radius: 10px; }
.hzbo-post .scene-cap { font-size: 12px; color: var(--text3); text-align: center; margin-top: 14px; line-height: 1.65; }
.hzbo-post .vs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 24px 0; }
@media (max-width: 640px) { .hzbo-post .vs-grid { grid-template-columns: 1fr; } }
.hzbo-post .vs-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.hzbo-post .vs-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; }
.hzbo-post .vs-card.cpu::before { background: var(--accent); }
.hzbo-post .vs-card.gpu::before { background: var(--accent2); }
.hzbo-post .vs-card h4 { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
.hzbo-post .vs-card.cpu h4 { color: var(--accent); }
.hzbo-post .vs-card.gpu h4 { color: var(--accent2); }
.hzbo-post .vs-card p { font-size: 13px; color: var(--text2); line-height: 1.7; margin: 0 0 8px; }
.hzbo-post .vs-card p:last-child { margin-bottom: 0; }
.hzbo-post .summary-box {
  background: linear-gradient(135deg, rgba(14,116,182,0.06) 0%, rgba(114,72,212,0.06) 100%);
  border: 1px solid rgba(14,116,182,0.18);
  border-radius: 16px;
  padding: 32px;
  margin: 32px 0;
}
.hzbo-post .summary-box h3 { font-size: 1.2rem; font-weight: 700; margin-bottom: 12px; color: var(--text); }
.hzbo-post .summary-box p { margin: 0 0 12px; font-size: 15px; line-height: 1.85; color: var(--text2); }
.hzbo-post .summary-box p:last-child { margin-bottom: 0; }
</style>

<div class="hzbo-post">
<span class="section-eyebrow" style="margin-top:0;">00 — 개요</span>
</div>

# 렌더러는 이전 프레임의 결과값으로 현재 프레임을 컬링한다

<div class="hzbo-post">
<p style="color:var(--text2);line-height:1.85;">
언리얼의 render thread가 한 프레임에서 가장 먼저 하는 일은 <strong>visibility 계산</strong>이다 — <code>InitViews</code>에서 프러스텀 컬링을 하고, occlusion 컬링으로 "다른 물체에 가려진 것"을 걸러내 이번 프레임에 그릴 목록을 확정한다. 그런데 이 occlusion 판정에 쓰이는 데이터를 들여다보면 이상한 점이 있다. HZB(Hierarchical Z-Buffer) 테스트 결과든 하드웨어 occlusion query 결과든, <strong>전부 이전 프레임에 GPU가 계산해 둔 것</strong>이다. 프레임 N의 컬링은 프레임 N-1(설정에 따라 N-2, N-4까지)의 장면을 근거로 이루어진다.
</p>

<p style="color:var(--text2);line-height:1.85;">
언뜻 버그처럼 들린다 — 이전 프레임의 카메라 위치에서 얻은 결과로 현재 프레임의 가시성을 판단하기 때문이다. 하지만 이것은 우회 불가능한 두 가지 제약이 만들어낸 <strong>의도된 설계</strong>이고, 엔진 코드 곳곳의 주석이 그 의도를 직접 증언한다. 이 글은 UE 5.8 소스를 따라가며 세 가지 질문에 답한다. <strong>① 왜 같은 프레임의 occlusion 결과를 쓸 수 없는가</strong>(순서와 파이프라이닝), <strong>② 엔진은 이 지연을 어떻게 구현했는가</strong>(링버퍼, readback, 프레임 넘버 검증), <strong>③ 지연의 부작용은 어떻게 관리되는가</strong>(폴백, bounds 확장, 보수적 테스트). 마지막으로 같은 문제를 정반대 방향에서 풀어버린 Nanite의 two-pass occlusion과 대비한다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>UE 5.8 소스를 직접 읽고 정리했다 — <code>Engine/Source/Runtime/Renderer/Private/</code>의 <code>SceneVisibility.cpp</code> · <code>SceneOcclusion.cpp</code> · <code>SceneViewOcclusionHistory.h</code> · <code>SceneViewState.h</code> · <code>DeferredShadingRenderer.cpp</code> · <code>Nanite/NaniteCullRaster.cpp</code>, 셰이더는 <code>Engine/Shaders/Private/HZBOcclusion.usf</code> · <code>Nanite/NaniteHZBCull.ush</code>. 인용한 코드 주석은 모두 원문 그대로다.</p>
</div>

<span class="section-eyebrow">01 — 배경</span>
</div>

# 두 개의 occlusion 시스템, 하나의 공통점

<div class="hzbo-post">
<p style="color:var(--text2);line-height:1.85;">
UE의 CPU visibility 파이프라인에는 occlusion 컬링 시스템이 둘 있고, <code>r.HZBOcclusion</code>으로 고른다. CVar 정의(<code>SceneVisibility.cpp:123</code>)의 주석이 곧 요약이다:
</p>

<div class="code-block"><span class="code-lang">SceneVisibility.cpp:123</span><span class="kw">static</span> FAutoConsoleVariableRef CVarHZBOcclusion(
    TEXT(<span class="hl">"r.HZBOcclusion"</span>), GHZBOcclusion,
    TEXT(<span class="hl">"Defines which occlusion system is used.\n"</span>)
    TEXT(<span class="hl">" 0: Hardware occlusion queries\n"</span>)
    TEXT(<span class="hl">" 1: Use HZB occlusion system (default, less GPU and CPU cost, more conservative results)"</span>)
    TEXT(<span class="hl">" 2: Force HZB occlusion system (overrides rendering platform preferences)"</span>), ...);</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>모드 0 — 하드웨어 occlusion query</strong>는 프리미티브의 바운딩 박스를 depth 테스트만 켠 채 그려보고 "몇 픽셀이나 depth 테스트를 통과했는가"를 GPU에 묻는 방식이다. 답이 0픽셀이면 가려진 것이다. <strong>모드 1 — HZB occlusion</strong>은 depth buffer를 mip 체인으로 축소한 HZB를 만들고, 프리미티브 bounds의 스크린 사각형을 적절한 mip 한 장과 비교하는 GPU 테스트를 일괄 실행한다. 쿼리를 프리미티브마다 발행하는 대신 최대 256×256개의 bounds를 텍스처 하나로 묶어 풀스크린 패스 한 번에 테스트하므로 CPU·GPU 비용이 싸다.
</p>

<div class="scene-fig">
<img src="{{site.baseurl}}/assets/img/post/hzb-occlusion/hzb-occlusion-core-sketch.webp" alt="HZB mip 체인과 프레임 N에서 만든 HZB를 프레임 N+1이 소비하는 구조">
<div class="scene-cap">HZB는 depth buffer를 절반씩 줄이며 각 텍셀에 가장 먼 depth를 남긴 mip 체인이다. 프레임 N에서 만들어진 HZB와 테스트 결과는 프레임 N+1의 visibility가 소비한다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
방식은 달라도 두 시스템의 공통점은 하나다 — <strong>테스트는 GPU에서 실행되고, 그 결과를 소비하는 쪽은 CPU(render thread)의 visibility 계산</strong>이라는 것. "가려졌는가"라는 질문 자체가 depth buffer를 전제로 하고, depth buffer는 GPU에만 있다. 문제는 이 생산자와 소비자가 프레임 타임라인에서 <strong>반대편 끝</strong>에 있다는 점이다.
</p>

<span class="section-eyebrow">02 — 프레임 타임라인</span>
</div>

# 소비가 생산보다 먼저 온다 — 닭과 달걀

<div class="hzbo-post">
<p style="color:var(--text2);line-height:1.85;">
<code>FDeferredShadingSceneRenderer::Render</code>의 실제 순서를 따라가 보자. 프레임 N에서 일어나는 일이다.
</p>

<div class="code-block"><span class="code-lang">DeferredShadingRenderer.cpp — 프레임 N의 순서 (요약)</span><span class="cm">// ① 프레임 맨 앞: visibility 계산 — 여기서 occlusion 판정이 필요하다 (:2121)</span>
BeginInitViews(GraphBuilder, ...);   <span class="cm">// ComputeViewVisibility → OcclusionCull</span>

<span class="cm">// ② depth prepass — 이제서야 이번 프레임 depth가 그려진다 (:2462)</span>
<span class="cm">// "Draw the scene pre-pass / early z pass, populating the scene depth buffer and HiZ"</span>
RenderPrePass(GraphBuilder, InViews, ...);

<span class="cm">// ③ depth가 준비된 뒤에야 occlusion 테스트를 "발행"할 수 있다 (:2779)</span>
<span class="cm">// "Early occlusion queries"</span>
RenderOcclusion(...);                <span class="cm">// BeginOcclusionTests → RenderHzb(BuildHZB → Submit) → Fence</span>

<span class="cm">// ④ 이번 프레임 HZB는 "다음 프레임의 이전 HZB"로 저장된다 (:605)</span>
GraphBuilder.QueueTextureExtraction(FurthestHZBTexture, &amp;View.ViewState-&gt;<span class="hl">PrevFrameViewInfo.HZB</span>);</div>

<p style="color:var(--text2);line-height:1.85;">
①에서 occlusion 판정이 필요한데, 판정의 재료인 depth buffer는 ②에서, HZB와 쿼리 결과는 ③에서 만들어진다. <strong>소비가 생산보다 프레임 내에서 앞선다.</strong> 이것이 첫 번째 제약 — 순서의 닭-달걀 문제다. "무엇을 그릴지" 정해야 depth를 그릴 수 있는데, "무엇이 가려졌는지" 알려면 depth가 필요하다. 순환을 끊는 방법은 하나뿐이다: <strong>지난 프레임의 depth로 이번 프레임의 가시성을 근사한다.</strong> ④의 변수명 <code>PrevFrameViewInfo.HZB</code>가 이 설계를 이름으로 증언한다 — 이번 프레임에 만든 HZB는 태어나는 순간부터 "다음 프레임의 이전 것"이다.
</p>

<div class="scene-fig">
<img src="{{site.baseurl}}/assets/img/post/hzb-occlusion/occlusion-frame-timeline-sketch.webp" alt="프레임 N과 N+1의 render thread 타임라인 — InitViews가 이전 프레임 결과를 읽고, Submit 결과는 readback을 거쳐 다음 프레임에 소비된다">
<div class="scene-cap">프레임 N의 Submit(GPU 테스트 + readback 큐잉) 결과는 프레임 N+1의 InitViews가 소비한다. 소비가 생산보다 먼저 오므로 같은 프레임 소비는 순서상 불가능하다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
그런데 순서만이 문제라면 다른 해법도 상상할 수 있다 — visibility 계산을 depth prepass 뒤로 미루고, GPU가 테스트를 끝낼 때까지 <strong>기다리면</strong> 되지 않나? 여기서 두 번째 제약이 등장한다.
</p>

<span class="section-eyebrow">03 — 파이프라이닝</span>
</div>

# 기다리면 안 되는 이유 — GPU는 원래 한 프레임 뒤에서 달린다

<div class="hzbo-post">
<p style="color:var(--text2);line-height:1.85;">
CPU(render thread)와 GPU는 직렬이 아니라 <strong>파이프라인</strong>으로 돈다. render thread가 프레임 N의 커맨드를 녹화·제출하는 동안 GPU는 아직 프레임 N-1을 그리고 있는 것이 정상 상태다. 이 어긋남이 있어야 양쪽 모두 쉬지 않고 일한다. 이 상태에서 render thread가 "방금 제출한 프레임 N의 occlusion 테스트 결과를 달라"고 기다리면 무슨 일이 벌어지는가 — GPU가 N-1을 마저 끝내고, N의 depth를 그리고, 테스트까지 실행하는 동안 CPU는 정지한다. 그 사이 CPU가 놀았으니 다음 프레임 제출이 늦어지고, 이번엔 GPU가 굶는다. <strong>readback 한 번의 대기가 파이프라인 전체를 직렬화시킨다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
이 트레이드오프는 추측이 아니라 CVar 주석에 박제되어 있다. 하드웨어 쿼리의 버퍼링 깊이를 정하는 <code>r.NumBufferedOcclusionQueries</code>(기본 1):
</p>

<div class="code-block"><span class="code-lang">ConsoleManager.cpp:4258</span><span class="kw">static</span> TAutoConsoleVariable&lt;int32&gt; CVarNumBufferedOcclusionQueries(
    TEXT(<span class="hl">"r.NumBufferedOcclusionQueries"</span>), <span class="num">1</span>,
    TEXT(<span class="hl">"Number of frames to buffer occlusion queries (including the current renderthread frame).\n"</span>
         <span class="hl">"More frames reduces the chance of stalling the CPU waiting for results,"</span>
         <span class="hl">" but increases out of date query artifacts."</span>), ...);</div>

<p style="color:var(--text2);line-height:1.85;">
"버퍼링 프레임을 늘리면 <strong>결과를 기다리며 CPU가 멈출 확률은 줄지만, 오래된 쿼리로 인한 아티팩트는 늘어난다</strong>" — 지연은 stall과 정확성을 맞바꾸는 다이얼이고, 엔진은 기본값으로 1프레임 지연을 선택했다. 모바일에서는 이 다이얼이 더 돌아간다. <code>FOcclusionQueryHelpers::GetNumBufferedFrames</code>(<code>SceneOcclusion.cpp:107</code>)는 모바일에서 프레임을 추가하며 이유를 이렇게 적었다:
</p>

<div class="code-block"><span class="code-lang">SceneOcclusion.cpp:114-129</span>NumExtraMobileFrames++; <span class="cm">// the mobile renderer just doesn't do much after the basepass, and hence it will be</span>
                        <span class="cm">// asking for the query results almost immediately; the results can't possibly be ready in 1 frame.</span>
...
<span class="cm">// Android, unfortunately, requires the RHIThread to mediate the readback of queries. Therefore we need an</span>
<span class="cm">// extra frame to avoid a stall in either thread. The RHIT needs to do read back after the queries are ready</span>
<span class="cm">// and before the RT needs them to avoid stalls. The RHIT may be busy when the queries become ready, so this is all very complicated.</span>
NumExtraMobileFrames++;</div>

<p style="color:var(--text2);line-height:1.85;">
"결과가 1프레임 안에 준비되는 것은 불가능하다(the results can't possibly be ready in 1 frame)" — 같은 프레임 소비가 왜 없는지에 대한 엔진 자신의 답이다. RHI thread가 분리된 플랫폼에서는 RT→RHIT→GPU→RHIT→RT로 홉이 늘어나 지연이 한 프레임 더 필요해진다. 그래서 버퍼링 상한은 <code>MaxBufferedOcclusionFrames = 4</code>(<code>SceneViewOcclusionHistory.h:29</code>)까지 열려 있다.
</p>

<div class="callout callout-warn">
<div class="callout-title">그래도 기다리는 순간이 하나 있다</div>
<p>GPU-bound 상황에서는 CPU가 어차피 남는다. 이때 엔진은 <code>FGPUOcclusion::WaitForLastOcclusionQuery</code>(<code>SceneVisibility.cpp:3298</code>)로 지난 프레임 마지막 쿼리를 <strong>의도적으로</strong> 기다리기도 하는데, 트레이스 스코프 이름이 노골적이다 — <code>GPUBound_WaitingForGPUForOcclusionQueries_SeeGPUTrack</code>. 즉 "기다리지 않는다"는 원칙의 예외조차 계측 가능한 명시적 선택으로 구현되어 있다.</p>
</div>

<span class="section-eyebrow">04 — 경로 A</span>
</div>

# 하드웨어 쿼리: 프레임 개수만큼의 링버퍼

<div class="hzbo-post">
<p style="color:var(--text2);line-height:1.85;">
지연을 받아들이기로 했으면, 구현 문제는 "N프레임 전에 발행한 쿼리를 어디에 보관했다가 어떻게 찾아 읽는가"가 된다. 프리미티브마다 <code>FPrimitiveOcclusionHistory</code>(<code>SceneViewOcclusionHistory.h:57</code>)가 뷰 스테이트에 살아남아 프레임 경계를 넘는다:
</p>

<div class="code-block"><span class="code-lang">SceneViewOcclusionHistory.h</span><span class="cm">/** The occlusion query which contains the primitive's pending occlusion results. */</span>
FRHIRenderQuery* <span class="hl">PendingOcclusionQuery</span>[FOcclusionQueryHelpers::MaxBufferedOcclusionFrames];
uint32 PendingOcclusionQueryFrames[FOcclusionQueryHelpers::MaxBufferedOcclusionFrames];
...
uint8 <span class="hl">WasOccludedLastFrame</span> : 1;
uint8 OcclusionStateWasDefiniteLastFrame : 1;</div>

<p style="color:var(--text2);line-height:1.85;">
슬롯 인덱싱에는 작은 트릭이 있다. 읽기 인덱스를 계산하는 <code>GetQueryLookupIndex</code>(<code>SceneViewOcclusionHistory.h:36</code>)의 주석:
</p>

<div class="code-block"><span class="code-lang">SceneViewOcclusionHistory.h:36-53</span><span class="cm">// queries are currently always requested earlier in the frame than they are issued.</span>
<span class="cm">// thus we can always overwrite the oldest query with the current one as we never need them</span>
<span class="cm">// to coexist.  This saves us a buffer entry.</span>
<span class="kw">const</span> uint32 QueryIndex = CurrentFrame % NumBufferedFrames;</div>

<p style="color:var(--text2);line-height:1.85;">
"쿼리는 항상 발행(issue)보다 요청(read)이 프레임 내에서 먼저 온다" — 02장의 타임라인 그대로다. 프레임 N에서 <code>N % NumBufferedFrames</code> 슬롯을 읽으면 정확히 NumBufferedFrames프레임 전에 발행된 쿼리가 나오고, 읽고 난 그 슬롯에 이번 프레임 쿼리를 덮어쓰면 되니 버퍼 한 칸이 절약된다. 소비 지점인 <code>FetchVisibilityForPrimitives</code>(<code>SceneVisibility.cpp:2821</code>)는 이렇게 읽는다:
</p>

<div class="code-block"><span class="code-lang">SceneVisibility.cpp:2821-2879 (발췌)</span><span class="cm">// Read the occlusion query results.</span>
FRHIRenderQuery* PastQuery = PrimitiveOcclusionHistory-&gt;<span class="fn">GetQueryForReading</span>(OcclusionFrameCounter,
    OcclusionState.NumBufferedFrames, OcclusionState.ReadBackLagTolerance, bGrouped);
<span class="kw">if</span> (PastQuery)
{
    <span class="kw">if</span> (RHIGetRenderQueryResult(PastQuery, NumSamples, <span class="num">true</span>))
    {
        <span class="cm">// The primitive is occluded if none of its bounding box's pixels</span>
        <span class="cm">// were visible in the previous frame's occlusion query.</span>
        bIsOccluded = (NumPixels == <span class="num">0</span>);
    }
    <span class="cm">// If the occlusion query failed, treat the primitive as visible.</span>
}
<span class="kw">else</span>
{
    <span class="cm">// If there's no occlusion query for the primitive, assume it is whatever it was last frame</span>
    bIsOccluded = PrimitiveOcclusionHistory-&gt;<span class="hl">WasOccludedLastFrame</span>;
    ...
}</div>

<p style="color:var(--text2);line-height:1.85;">
눈여겨볼 것 세 가지. 첫째, <code>RHIGetRenderQueryResult</code>의 마지막 인자 <code>bWait=true</code>지만 이것은 stall이 아니다 — 읽는 쿼리가 이미 N프레임 전에 발행됐으므로 GPU는 거의 확실히 끝냈다. <strong>지연 소비 구조 자체가 "기다려도 기다릴 게 없는" 상태를 만든다.</strong> 둘째, 주석이 명시하듯 판정 근거는 "previous frame's occlusion query"다. 셋째, 쿼리가 없거나 유효하지 않으면 <code>WasOccludedLastFrame</code> — 지난 프레임의 결론 — 으로 폴백한다. 결과가 늦으면 그리던 대로 그린다는, 시간적 일관성(temporal coherence)에 기댄 안전장치다.
</p>

<p style="color:var(--text2);line-height:1.85;">
너무 오래된 쿼리는 아예 읽지 않는다. <code>GetQueryForReading</code>(<code>SceneViewOcclusionHistory.h:174</code>)은 <code>LagTolerance</code>보다 오래 지난 쿼리를 버린다 — "Never read from queries older than LagTolerance. <strong>They may have already been reused and will give incorrect results</strong>". 쿼리 오브젝트는 풀에서 재사용되므로, 슬롯에 남은 핸들이 이미 다른 용도로 쓰였을 수 있기 때문이다. VR의 <code>vr.RoundRobinOcclusion</code>(좌/우안을 격프레임으로 교대 쿼리)에서는 결과가 최대 2배 오래될 수 있어 tolerance도 2배로 늘린다(<code>SceneVisibility.cpp:3239</code>).
</p>

<span class="section-eyebrow">05 — 경로 B</span>
</div>

# HZB 테스터: 텍스처 readback의 1프레임 사이클

<div class="hzbo-post">
<p style="color:var(--text2);line-height:1.85;">
기본값인 HZB 경로(<code>FHZBOcclusionTester</code>)는 쿼리 오브젝트 대신 <strong>텍스처 readback</strong>으로 같은 구조를 만든다. 프레임 N에서 벌어지는 사이클 전체가 이 시스템의 요약이다:
</p>

<div class="data-table">
<table>
<thead><tr><th>순서</th><th>단계</th><th>코드</th><th>하는 일</th></tr></thead>
<tbody>
<tr><td>①</td><td>MapResults</td><td><code>SceneVisibility.cpp:3257</code> → <code>SceneOcclusion.cpp:845</code></td><td>InitViews 초입. <strong>프레임 N-1의</strong> readback 결과를 Lock</td></tr>
<tr><td>②</td><td>IsVisible</td><td><code>SceneVisibility.cpp:2811</code></td><td>프리미티브별 판정 — 단 <code>IsValidFrame(LastTestFrameNumber)</code>일 때만 신뢰</td></tr>
<tr><td>③</td><td>AddBounds</td><td><code>SceneVisibility.cpp:2973</code>, <code>SceneVisibilityPrivate.h:1035</code></td><td>이번 프레임에 테스트할 bounds 등록(최대 256×256개), <code>HZBTestIndex</code> 저장</td></tr>
<tr><td>④</td><td>Submit</td><td><code>SceneOcclusion.cpp:951</code></td><td>depth prepass·BuildHZB 후. bounds를 텍스처로 업로드 → <code>FHZBTestPS</code> 풀스크린 테스트 → 결과 256×256 텍스처</td></tr>
<tr><td>⑤</td><td>readback 큐잉</td><td><code>SceneOcclusion.cpp:1062</code></td><td><code>AddEnqueueCopyPass(GraphBuilder, ResultsReadback.Get(), ResultsTextureGPU)</code> — 주석 "Transfer memory GPU → CPU"</td></tr>
<tr><td>⑥</td><td>소비</td><td>프레임 N+1의 ①</td><td>다음 프레임 MapResults가 이 복사본을 Lock — <strong>정확히 1프레임 지연</strong></td></tr>
</tbody>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
①의 Lock이 블로킹 API라는 점이 흥미로운데, 주석이 왜 문제없는지를 설명한다:
</p>

<div class="code-block"><span class="code-lang">SceneOcclusion.cpp:845 — MapResults</span><span class="cm">// RHIMapStagingSurface will block until the results are ready (from the previous frame)</span>
<span class="cm">// so we need to consider this RT idle time</span>
FRenderThreadIdleScope IdleScope(ERenderThreadIdleTypes::<span class="hl">WaitingForGPUQuery</span>);
ResultsBuffer = <span class="kw">reinterpret_cast</span>&lt;<span class="kw">const</span> uint8*&gt;(ResultsReadback-&gt;<span class="fn">Lock</span>(ResultsBufferRowPitch, ...));</div>

<p style="color:var(--text2);line-height:1.85;">
기다리는 대상이 "이전 프레임에" 큐잉된 복사이므로 실제로는 거의 항상 즉시 반환된다 — 그래도 만에 하나의 대기를 프로파일러에 정직하게 잡히도록 RT idle 시간으로 계측한다. 결과가 아예 없는 경우(첫 프레임, 디바이스 리셋)에는 <code>{255}</code> 한 바이트짜리 정적 버퍼로 바꿔치기해 <strong>전부 visible</strong>로 폴백한다(<code>SceneOcclusion.cpp:865</code>) — occlusion 컬링의 실패 모드는 언제나 "덜 컬링하는 쪽"이어야 하기 때문이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
stale 결과 방어는 <code>ValidFrameNumber</code>가 맡는다. 테스트가 실제로 GPU에 제출된 프레임 번호만 <code>SetValidFrameNumber</code>로 기록되고(<code>SceneVisibility.cpp:3292</code>), 프리미티브가 bounds를 등록한 프레임(<code>LastTestFrameNumber</code>)과 일치할 때만 ②에서 결과를 신뢰한다. 무효 상태는 <code>InvalidFrameNumber = 0xffffffff</code>인데 유효 번호는 <code>FrameNumberMask = 0x7fffffff</code>로 마스킹되므로 <strong>둘은 절대 충돌할 수 없다</strong>(<code>SceneOcclusion.cpp:788</code>, 주석 "this number cannot be set by SetValidFrameNumber()"). 하드웨어 쿼리의 LagTolerance와 똑같은 역할 — <strong>어긋난 시점의 답을 정답으로 오인하는 것만은 막는다</strong> — 을 프레임 넘버 비교로 수행하는 것이다.
</p>

<span class="section-eyebrow">06 — 지연의 대가</span>
</div>

# popping, 그리고 지연을 계약으로 만드는 장치들

<div class="hzbo-post">
<p style="color:var(--text2);line-height:1.85;">
1프레임 지연의 대가는 명확하다. 카메라가 빠르게 돌거나 가리개가 치워지면, "그 물체가 보인다"는 사실을 GPU가 확인한 것은 이번 프레임인데 CPU가 그 답을 받는 것은 다음 프레임이다 — 그 사이 한 프레임 동안 물체는 <strong>실제로는 보여야 하는데 그려지지 않는다</strong>. 이것이 occlusion popping이다. CSM(캐스케이드 섀도맵) occlusion이 기본 꺼져 있는 이유를 설명하는 주석(<code>SceneOcclusion.cpp:60</code>)이 이 한계를 정확한 용어로 부른다 — "rapid view changes reveal new regions too quickly for <strong>latent occlusion queries</strong> to work with". 엔진 스스로 이 시스템을 <strong>latent</strong>(잠복성) 쿼리라고 부르는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 엔진은 지연을 없애는 대신, 지연이 있어도 틀리지 않도록 판정을 <strong>체계적으로 보수화</strong>한다. 방향은 전부 같다 — <em>애매하면 visible, 컬링은 확실할 때만.</em>
</p>

<div class="data-table">
<table>
<thead><tr><th>장치</th><th>코드</th><th>내용</th></tr></thead>
<tbody>
<tr><td>상시 bounds 확장</td><td><code>OCCLUSION_SLOP (1.0f)</code><br><code>SceneViewOcclusionHistory.h:17</code>, <code>PrimitiveSceneInfo.cpp:1976</code></td><td>모든 occlusion bounds를 1유닛씩 키워서 테스트 — 경계선상의 오판을 줄인다</td></tr>
<tr><td>신규 진입 프리미티브 확장</td><td><code>r.GFramesNotOcclusionTestedToExpandBBoxes</code>(5) 외<br><code>SceneVisibility.cpp:215-268</code></td><td>"오래 테스트 안 된 프리미티브는 다시 테스트할 때 몇 프레임간 BBox를 키운다" — 프러스텀에 막 들어온 것이 지연 때문에 늦게 나타나는 것을 완화. 주석은 이상적 해법으로 "카메라 속도·각속도로 <strong>다음 m프레임 내 드러날 것을 외삽</strong>"까지 언급한다(:248)</td></tr>
<tr><td>쿼리 유예</td><td><code>BecameEligibleForQueryCooldown</code><br><code>SceneViewOcclusionHistory.h:88</code></td><td>"막 occlusion 대상이 된 것들은 프러스텀 안으로 스치듯 들어오는 중일 수 있으니, <strong>몇 프레임은 visible로 두고 그 다음에 진짜 쿼리를 시작한다</strong>"</td></tr>
<tr><td>히스토리 폴백</td><td><code>WasOccludedLastFrame</code><br><code>SceneVisibility.cpp:2848</code></td><td>결과가 없으면 지난 프레임 결론 유지 — 갑작스런 상태 반전 방지</td></tr>
<tr><td>실패 시 visible</td><td><code>SceneVisibility.cpp:2843</code>, <code>SceneOcclusion.cpp:865</code></td><td>쿼리 실패·첫 프레임·디바이스 리셋 — 전부 "그린다" 쪽으로 넘어진다</td></tr>
</tbody>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
보수성은 GPU 테스트 자체에도 스며 있다. HZB 테스트 셰이더(<code>HZBOcclusion.usf:13</code>)는 bounds가 near plane을 가로지르면 테스트 없이 visible로 두고, 스크린 사각형을 4텍셀 footprint로 덮는 mip을 고르되 정렬이 어긋나면 한 단계 더 큰 mip으로 물러난다(<code>NaniteHZBCull.ush:40</code>, "Go one extra level down for 4x4 sampling"). 그리고 4×4 텍셀을 Gather로 읽어 <strong>min depth — 그 영역에서 가장 먼 occluder — </strong>와 비교한다(<code>:135-193</code>). inverted-Z에서 <code>Rect.Depth &gt;= MinDepth</code>면 visible(<code>:195</code>) — 즉 사각형 안의 어느 한 텍셀이라도 뚫려 있으면 살려준다. <code>r.HZBOcclusion</code> 주석의 "more conservative results"가 이 뜻이다.
</p>

<div class="callout callout-info">
<div class="callout-title">지연은 버그가 아니라 계약이다</div>
<p>링버퍼와 프레임 넘버 검증은 "몇 프레임 전의 답인지"를 정확히 추적하고, LagTolerance와 ValidFrameNumber는 계약 범위를 벗어난 답을 폐기하며, 히스토리 폴백과 bounds 확장과 min-depth 보수성은 계약이 어긋난 순간에도 화면이 크게 틀리지 않도록 보증한다. "1프레임 늦은 답"은 이 보증 장치들 위에서만 안전하게 쓸 수 있고, 엔진 구현의 대부분은 지연 그 자체가 아니라 <strong>이 보증 장치들</strong>이다.</p>
</div>

<span class="section-eyebrow">07 — 대비</span>
</div>

# Nanite two-pass: 기다리지 말고, 소비자를 GPU로 옮겨라

<div class="hzbo-post">
<p style="color:var(--text2);line-height:1.85;">
이 지연 문제의 근본 원인을 다시 짚으면 — <strong>생산자는 GPU인데 소비자가 CPU</strong>라서다. 그렇다면 소비자까지 GPU로 옮기면? 컬링 판정과 드로우 생성이 모두 GPU에서 일어나면 readback이 사라지고, 같은 프레임 안에서 "이전 프레임 근사 → 이번 프레임 검증"의 2단계를 모두 돌 수 있다. Nanite의 two-pass occlusion(<code>r.Nanite.Culling.TwoPass</code>)이 정확히 이 구조다.
</p>

<div class="code-block"><span class="code-lang">NaniteCullRaster.cpp — two-pass 구조 (발췌)</span><span class="cm">// Main pass: 이전 프레임 HZB로 1차 컬링 — "HZB (if provided) comes from the previous frame" (:6801)</span>
CullingParameters.HZBTexture = <span class="hl">PrevHZB</span>;
AddPass_InstanceHierarchyAndClusterCull( CULLING_PASS_OCCLUSION_MAIN );  <span class="cm">// 가려진 것은 OccludedInstances 버퍼로</span>
MainPassBinning = AddPass_Rasterize(...);        <span class="cm">// 살아남은 것 먼저 래스터 → 이번 프레임 depth 확보</span>

<span class="cm">// Occlusion post pass. Retest instances and clusters that were not visible last frame.</span>
<span class="cm">// If they are visible now, render them. (:7021)</span>
<span class="fn">BuildHZBFurthest</span>(..., SceneDepth, RasterizedDepth, ..., TEXT(<span class="hl">"Nanite.PreviousOccluderHZB"</span>), ...);
CullingParameters.HZBTexture = OutFurthestHZBTexture;   <span class="cm">// 이번 프레임 depth로 HZB 재빌드</span>
AddPass_InstanceHierarchyAndClusterCull( CULLING_PASS_OCCLUSION_POST ); <span class="cm">// 탈락자 재심사</span>
PostPassBinning = AddPass_Rasterize(...);        <span class="cm">// 이번 프레임 안에서 마저 그린다</span></div>

<div class="vs-grid">
<div class="vs-card cpu">
<h4>CPU visibility (이 글의 주제)</h4>
<p>판정 주체가 render thread — GPU 결과를 CPU로 <strong>readback해야만</strong> 드로우 목록에 반영할 수 있다.</p>
<p>readback 대기는 파이프라인 stall이므로 결과를 1~4프레임 버퍼링. <strong>오차는 다음 프레임에야 교정</strong>되고, 그 한 프레임이 popping으로 보인다.</p>
<p>대신 모든 종류의 프리미티브에 적용 가능하고, CPU에서 드로우콜 자체를 없애준다.</p>
</div>
<div class="vs-card gpu">
<h4>Nanite two-pass (GPU-driven)</h4>
<p>판정도 드로우 생성도 GPU — readback이 없다. 이전 프레임 HZB는 <strong>1차 근사</strong>로만 쓰고, 이번 프레임 depth로 HZB를 다시 만들어 탈락자를 <strong>같은 프레임 안에서 재심사·렌더</strong>한다.</p>
<p>지연에서 오는 popping이 구조적으로 사라진다. 이전 프레임 HZB가 없으면 two-pass 자체를 끈다(:4088).</p>
<p>단, GPU가 소비할 수 있는 것(Nanite 클러스터, GPU 인스턴스 컬링)에만 가능한 해법이다.</p>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
흥미로운 경계 사례가 <code>r.InstanceCulling.OcclusionQueries</code>다. GPU에서 인스턴스별 소프트웨어 쿼리를 그리지만 그 결과가 <strong>CPU visibility에 물리는</strong> 경로라서, 주석대로 "save the mask to interpret results <strong>on the next frame</strong>"(<code>DeferredShadingRenderer.cpp:631</code>) — 여전히 다음 프레임 해석이다. 지연을 만드는 것은 테스트가 어디서 실행되느냐가 아니라 <strong>결과를 누가 소비하느냐</strong>임을 보여주는 반례다.
</p>

<span class="section-eyebrow">08 — 정리</span>
</div>

# 정리

<div class="hzbo-post">
<div class="summary-box">
<h3>왜 이렇게 되는가</h3>
<p><strong>순서:</strong> visibility(소비)는 프레임 맨 앞에서 돌고, occlusion 데이터(생산 — depth, HZB, 쿼리 결과)는 그 뒤에 GPU에서 만들어진다. 같은 프레임 소비는 순서상 불가능하다. <strong>파이프라이닝:</strong> GPU는 CPU보다 한 프레임 뒤에서 달리는 것이 정상이므로, 이번 프레임 결과를 재촉하는 readback은 파이프라인 전체를 직렬화시킨다. 엔진은 기다리는 대신 <strong>이전 프레임의 결과값을 사용</strong>하며, <code>r.NumBufferedOcclusionQueries</code> 주석이 이 트레이드오프(stall ↔ out-of-date 아티팩트)를 명시한다.</p>
<h3>왜 이렇게 구현되었는가</h3>
<p>지연을 전제로 한 계약을 안전하게 만드는 방향이다. 하드웨어 쿼리는 <code>PendingOcclusionQuery</code> 링버퍼(<code>CurrentFrame % NumBufferedFrames</code> — 읽기가 쓰기보다 먼저 오니 같은 슬롯을 재활용), HZB는 <code>FRHIGPUTextureReadback</code>의 1프레임 사이클로 지연을 구현하고, <code>ValidFrameNumber</code>·<code>LagTolerance</code>가 어긋난 시점의 답을 폐기하며, <code>WasOccludedLastFrame</code> 폴백·<code>OCCLUSION_SLOP</code>·신규 진입 bbox 확장·4×4 min-depth 보수 테스트가 "애매하면 visible" 원칙으로 popping을 누른다. 실패 모드는 언제나 덜 컬링하는 쪽이다.</p>
<p>그리고 이 지연을 진짜로 없애는 방법은 기다리는 것이 아니라 <strong>소비자를 GPU로 옮기는 것</strong>이었다 — Nanite two-pass는 이전 프레임 HZB로 1차 컬링하고, 이번 프레임 depth로 HZB를 재빌드해 같은 프레임 안에서 탈락자를 재심사한다. readback이 없으니 지연도 없다. 이전 프레임의 결과값으로 컬링하는 CPU 경로와, 그 결과를 1차 근사로만 사용한 뒤 현재 프레임 안에서 검증을 끝내는 GPU 경로 — 두 설계의 차이는 결국 "결과를 누가 소비하는가" 하나로 수렴한다.</p>
</div>
</div>
