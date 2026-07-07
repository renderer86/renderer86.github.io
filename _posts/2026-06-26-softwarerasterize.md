---
layout: post
title: "소프트웨어 래스터라이저: tinyrenderer에서 UE5 Nanite까지"
icon: paper
permalink: swraster
categories: Rendering
tags: [Rendering, UnrealEngine, Nanite, Rasterization]
excerpt: "삼각형을 픽셀로 바꾸는 래스터화의 기본 원리부터, 고정함수 하드웨어 래스터라이저가 작은 삼각형에서 왜 비효율적인지, 그리고 UE5 Nanite가 컴퓨트 셰이더로 소프트웨어 래스터라이저를 다시 만든 이유와 그 내부 구조까지"
back_color: "#ffffff"
img_name: "swraster.webp"
toc: false
show: true
new: true
series: -1
---
>
> **이런 분이 읽으면 좋습니다!**
>
> - 래스터화(삼각형 → 픽셀)가 도대체 무슨 연산인지 코드 수준에서 보고 싶은 분
> - GPU의 고정함수 래스터라이저가 어떻게 동작하고, 왜 작은 삼각형에 약한지 궁금한 분
> - Nanite가 왜 GPU에 멀쩡한 래스터라이저를 두고 소프트웨어 래스터라이저를 다시 만들었는지 궁금한 분
>
> **이 글로 알 수 있는 내용**
>
> - `tinyrenderer`로 보는 래스터화의 최소 골격 — 엣지 함수, barycentric, z-buffer
> - 고정함수 하드웨어 래스터 파이프라인과 2×2 쿼드 셰이딩의 구조적 낭비
> - Nanite 소프트웨어 래스터라이저의 실제 코드 (`MicropolyRasterize` · `SetupTriangle` · `RasterizeTri_Scanline`)
> - 64비트 VisBuffer와 `InterlockedMax`로 깊이 테스트를 대체하는 기법
> - 클러스터를 SW/HW 경로로 가르는 정확한 기준(`r.Nanite.MinPixelsPerEdgeHW`)

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.re-post {
  --bg2: #f4f6fb;
  --bg3: #eef0f7;
  --surface: #f9fafd;
  --surface2: #eceef7;
  --border: rgba(60,80,180,0.10);
  --border2: rgba(60,80,180,0.22);
  --text: #1a1d2e;
  --text2: #464c6a;
  --text3: #8890aa;
  --accent: #3d63e0;
  --accent2: #7248d4;
  --gold: #b07d00;
  --teal: #0a8f62;
  --coral: #d63031;
  --orange: #c85a00;
}
.re-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: none;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.re-post .term-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
  margin: 28px 0;
}
.re-post .term-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.re-post .term-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.re-post .term-card.blue::before   { background: var(--accent); }
.re-post .term-card.gold::before   { background: var(--gold); }
.re-post .term-card.teal::before   { background: var(--teal); }
.re-post .term-card.coral::before  { background: var(--coral); }
.re-post .term-card.purple::before { background: var(--accent2); }
.re-post .term-card.orange::before { background: var(--orange); }
.re-post .term-symbol {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.re-post .term-card.blue   .term-symbol { color: var(--accent); }
.re-post .term-card.gold   .term-symbol { color: var(--gold); }
.re-post .term-card.teal   .term-symbol { color: var(--teal); }
.re-post .term-card.coral  .term-symbol { color: var(--coral); }
.re-post .term-card.purple .term-symbol { color: var(--accent2); }
.re-post .term-card.orange .term-symbol { color: var(--orange); }
.re-post .term-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.re-post .term-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.re-post .callout {
  border-radius: 12px;
  padding: 18px 22px;
  margin: 24px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.re-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.re-post .callout-info { background: rgba(61,99,224,0.05); border-color: rgba(61,99,224,0.18); }
.re-post .callout-info::before { background: var(--accent); }
.re-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.re-post .callout-warn::before { background: var(--gold); }
.re-post .callout-teal { background: rgba(10,143,98,0.05); border-color: rgba(10,143,98,0.20); }
.re-post .callout-teal::before { background: var(--teal); }
.re-post .callout-purple { background: rgba(114,72,212,0.05); border-color: rgba(114,72,212,0.20); }
.re-post .callout-purple::before { background: var(--accent2); }
.re-post .callout-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.re-post .callout-info .callout-title { color: var(--accent); }
.re-post .callout-warn .callout-title { color: var(--gold); }
.re-post .callout-teal .callout-title { color: var(--teal); }
.re-post .callout-purple .callout-title { color: var(--accent2); }
.re-post .callout p { margin: 0; font-size: 14px; color: var(--text2); line-height: 1.75; }
.re-post .callout p + p { margin-top: 8px; }
.re-post .mapping-table {
  width: 100%;
  border-collapse: collapse;
  margin: 28px 0;
  font-size: 14px;
}
.re-post .mapping-table th {
  background: var(--surface2);
  padding: 10px 14px;
  text-align: left;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text3);
  border: 1px solid var(--border);
}
.re-post .mapping-table td {
  padding: 12px 14px;
  border: 1px solid var(--border);
  vertical-align: top;
  line-height: 1.6;
}
.re-post .mapping-table tr            { background: #ffffff; }
.re-post .mapping-table tr:nth-child(odd) { background: var(--surface); }
.re-post .mapping-table tr:hover      { background: var(--surface2); }
.re-post .mono-cell { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--accent); font-weight: 600; }
.re-post .desc-cell { color: var(--text2); }
.re-post .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 28px 0; }
@media (max-width: 640px) {
  .re-post .two-col { grid-template-columns: 1fr; }
  .re-post .term-grid { grid-template-columns: 1fr; }
}
.re-post .col-box { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
.re-post .col-box h4 { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.re-post .col-box ul { margin: 0; padding-left: 0; list-style: none; }
.re-post .col-box li { font-size: 13px; color: var(--text2); padding: 5px 0; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.re-post .col-box li:last-child { border-bottom: none; }
.re-post .col-box li .li-name { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--accent); font-weight: 600; flex-shrink: 0; }
.re-post .col-box li .li-val  { font-size: 12px; color: var(--text2); text-align: right; }
.re-post .summary-box {
  background: linear-gradient(135deg, rgba(61,99,224,0.06) 0%, rgba(114,72,212,0.06) 100%);
  border: 1px solid rgba(61,99,224,0.18);
  border-radius: 16px;
  padding: 36px;
  margin: 32px 0;
  text-align: center;
}
.re-post .summary-box h3 { font-size: 1.25rem; font-weight: 700; margin-bottom: 12px; color: var(--text); }
.re-post .summary-box p  { color: var(--text2); max-width: 640px; margin: 0 auto; font-size: 15px; line-height: 1.85; }
.re-post .sub-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 22px 26px;
  margin: 20px 0;
}
.re-post .sub-section h4 {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.re-post .sub-section p {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.75;
  margin: 0;
}
.re-post .sub-section p + p { margin-top: 8px; }
.re-post .code-block {
  background: #161927;
  border: 1px solid rgba(120,140,220,0.18);
  border-radius: 10px;
  padding: 16px 18px;
  margin: 20px 0;
  overflow-x: auto;
}
.re-post .code-block pre {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.72;
  color: #d4d9ec;
  white-space: pre;
}
.re-post .code-cap {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text3);
  letter-spacing: 0.03em;
  margin-bottom: 8px;
}
.re-post .code-block .cmt { color: #6b7394; font-style: italic; }
.re-post .code-block .key { color: #7ba8ff; }
.re-post .code-block .fn  { color: #9ad0a0; }
.re-post .code-block .num { color: #e0a878; }
.re-post .pipe-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 8px;
  margin: 24px 0;
}
.re-post .pipe-flow .pf-box {
  flex: 1 1 0;
  min-width: 110px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 12px 10px;
  text-align: center;
}
.re-post .pipe-flow .pf-box .pf-step { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text3); margin-bottom: 4px; }
.re-post .pipe-flow .pf-box .pf-name { font-size: 12px; font-weight: 700; color: var(--text); line-height: 1.4; }
.re-post .pipe-flow .pf-arrow { display: flex; align-items: center; color: var(--text3); font-size: 16px; }
.re-post .key-fact {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  background: var(--bg2);
  padding: 10px 14px;
  border-radius: 8px;
  color: var(--accent);
  line-height: 1.9;
  margin: 12px 0;
  overflow-x: auto;
}
.re-post .ref-list { list-style: none; padding-left: 0; margin: 16px 0; }
.re-post .ref-list li { font-size: 13px; color: var(--text2); line-height: 1.7; padding: 7px 0; border-bottom: 1px solid var(--border); }
.re-post .ref-list li:last-child { border-bottom: none; }
.re-post .ref-list .ref-tag { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--accent2); font-weight: 600; }
.re-post .raster-compare {
  margin: 28px 0;
  padding: 18px;
  border: 1px solid var(--border2);
  border-radius: 14px;
  background: linear-gradient(180deg, #fff 0%, var(--surface) 100%);
}
.re-post .raster-compare-title {
  font-size: 13px;
  font-weight: 800;
  color: var(--text);
  margin-bottom: 16px;
}
.re-post .raster-compare-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.re-post .raster-lane {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
  padding: 14px;
}
.re-post .raster-lane h4 {
  margin: 0 0 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text);
}
.re-post .mini-screen {
  height: 158px;
  border: 1px solid var(--border2);
  border-radius: 8px;
  background:
    linear-gradient(var(--border) 1px, transparent 1px),
    linear-gradient(90deg, var(--border) 1px, transparent 1px),
    linear-gradient(135deg, rgba(61,99,224,0.04), rgba(10,143,98,0.04));
  background-size: 18px 18px, 18px 18px, auto;
  position: relative;
  overflow: hidden;
}
.re-post .tri {
  position: absolute;
  width: 0;
  height: 0;
  border-left: 54px solid transparent;
  border-right: 54px solid transparent;
  border-bottom: 104px solid rgba(255,255,255,0.86);
  filter: drop-shadow(0 0 0 #202020);
}
.re-post .tri::after {
  content: '';
  position: absolute;
  left: -54px;
  top: 0;
  width: 108px;
  height: 104px;
  clip-path: polygon(50% 0%, 0% 100%, 100% 100%);
  border: 2px solid #202020;
}
.re-post .bbox {
  position: absolute;
  border: 2px dashed rgba(32,32,32,0.72);
  background: rgba(176,125,0,0.06);
}
.re-post .quad {
  position: absolute;
  width: 72px;
  height: 72px;
  border: 2px solid rgba(61,99,224,0.74);
  background:
    linear-gradient(rgba(61,99,224,0.22) 0 0) 0 0 / 36px 36px no-repeat,
    linear-gradient(rgba(61,99,224,0.10) 0 0) 36px 0 / 36px 36px no-repeat,
    linear-gradient(rgba(61,99,224,0.10) 0 0) 0 36px / 36px 36px no-repeat,
    linear-gradient(rgba(61,99,224,0.10) 0 0) 36px 36px / 36px 36px no-repeat;
}
.re-post .thread-dot {
  position: absolute;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--teal);
  box-shadow: 0 0 0 6px rgba(10,143,98,0.10);
}
.re-post .lane-flow {
  display: grid;
  grid-template-columns: 1fr;
  gap: 7px;
  margin-top: 12px;
}
.re-post .lane-node {
  border: 1px solid var(--border2);
  border-radius: 8px;
  padding: 9px 10px;
  background: var(--surface);
  font-size: 12px;
  line-height: 1.45;
  color: var(--text2);
}
.re-post .lane-node strong {
  display: block;
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  margin-bottom: 2px;
}
.re-post .lane-arrow {
  text-align: center;
  color: var(--text3);
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
}
.re-post .raster-compare-caption {
  margin-top: 14px;
  font-size: 12px;
  color: var(--text2);
  line-height: 1.65;
}
@media (max-width: 820px) {
  .re-post .raster-compare-grid { grid-template-columns: 1fr; }
}
</style>

<div class="re-post">

<p style="color:var(--text2);line-height:1.85;margin-bottom:8px;margin-top:8px;">
  3D 렌더링의 가장 밑바닥에는 단 하나의 질문이 있다. <strong>"이 삼각형은 화면의 어느 픽셀들을 덮는가?"</strong> 이 질문에 답해 삼각형을 픽셀 격자로 바꾸는 과정이 <strong>래스터화(rasterization)</strong>다. 오늘날 GPU에는 이 일만 전담하는 고정함수(fixed-function) 하드웨어 유닛이 박혀 있다. 그런데 UE5의 Nanite는 그 멀쩡한 하드웨어를 두고, 작은 삼각형만큼은 <strong>컴퓨트 셰이더로 소프트웨어 래스터라이저를 다시 만들어</strong> 직접 처리한다. 그게 더 빠르기 때문이다.
</p>
<p style="color:var(--text2);line-height:1.85;margin-bottom:24px;">
  이 글은 래스터화의 최소 골격을 <code>tinyrenderer</code>로 먼저 잡은 뒤, 고정함수 하드웨어 래스터라이저의 동작과 그 약점을 살펴보고, 마지막으로 Nanite가 만든 소프트웨어 래스터라이저의 실제 셰이더 코드를 파헤친다. 소스 인용은 <strong>UE 5.7.4</strong>와 <a href="https://github.com/ssloy/tinyrenderer"><code>ssloy/tinyrenderer</code></a> 기준이며, 설계 의도는 Epic의 SIGGRAPH 2021 강연 <em>"A Deep Dive into Nanite Virtualized Geometry"</em>로 교차 확인했다.
</p>

<div class="raster-compare">
  <div class="raster-compare-title">세 래스터라이저가 같은 삼각형을 나누는 방식</div>
  <div class="raster-compare-grid">
    <div class="raster-lane">
      <h4>CPU Rasterizer</h4>
      <div class="mini-screen">
        <div class="bbox" style="left:42px;top:26px;width:142px;height:106px;"></div>
        <div class="tri" style="left:60px;top:30px;transform:rotate(8deg) scale(.78);"></div>
      </div>
      <div class="lane-flow">
        <div class="lane-node"><strong>Triangle</strong>화면 좌표 삼각형을 받는다.</div>
        <div class="lane-arrow">↓</div>
        <div class="lane-node"><strong>Bounding Box</strong>삼각형을 감싸는 사각형만 순회한다.</div>
        <div class="lane-arrow">↓</div>
        <div class="lane-node"><strong>Pixel 검사</strong>각 픽셀 중심이 삼각형 안인지 barycentric/edge 함수로 검사한다.</div>
      </div>
    </div>
    <div class="raster-lane">
      <h4>HW Rasterizer</h4>
      <div class="mini-screen">
        <div class="tri" style="left:64px;top:24px;transform:rotate(-10deg) scale(.76);"></div>
        <div class="quad" style="left:86px;top:58px;"></div>
      </div>
      <div class="lane-flow">
        <div class="lane-node"><strong>Triangle</strong>고정함수 유닛이 삼각형 셋업을 한다.</div>
        <div class="lane-arrow">↓</div>
        <div class="lane-node"><strong>2x2 Quad</strong>픽셀 셰이딩과 미분을 위해 항상 네 픽셀 단위로 실행한다.</div>
        <div class="lane-arrow">↓</div>
        <div class="lane-node"><strong>낭비</strong>작은 삼각형은 한 픽셀만 유효해도 나머지 레인이 helper lane이 된다.</div>
      </div>
    </div>
    <div class="raster-lane">
      <h4>Nanite</h4>
      <div class="mini-screen">
        <div class="tri" style="left:34px;top:22px;transform:rotate(16deg) scale(.42);"></div>
        <div class="tri" style="left:105px;top:36px;transform:rotate(-12deg) scale(.40);"></div>
        <div class="tri" style="left:70px;top:88px;transform:rotate(4deg) scale(.38);"></div>
        <span class="thread-dot" style="left:84px;top:56px;"></span>
        <span class="thread-dot" style="left:154px;top:66px;"></span>
        <span class="thread-dot" style="left:120px;top:118px;"></span>
      </div>
      <div class="lane-flow">
        <div class="lane-node"><strong>Triangle</strong>마이크로폴리곤이 많다는 사실을 이용한다.</div>
        <div class="lane-arrow">↓</div>
        <div class="lane-node"><strong>Thread</strong>컴퓨트 레인 하나가 작은 삼각형 하나를 맡는다.</div>
        <div class="lane-arrow">↓</div>
        <div class="lane-node"><strong>VisBuffer</strong>색 대신 삼각형 ID + 깊이만 atomic으로 기록한다.</div>
      </div>
    </div>
  </div>
  <div class="raster-compare-caption">CPU 예제는 바운딩 박스 안의 픽셀을 검사한다. 하드웨어는 픽셀 병렬화에 강하지만 2x2 quad가 최소 단위라 작은 삼각형에서 helper lane 낭비가 생긴다. Nanite는 픽셀이 아니라 삼각형을 병렬화 단위로 잡아 마이크로폴리곤 워크로드에 맞춘다.</div>
</div>

<div class="callout callout-info">
  <div class="callout-title">래스터화 vs 레이트레이싱</div>
  <p>화면에 그리는 방법은 크게 둘이다. <strong>래스터화</strong>는 "삼각형마다 → 어떤 픽셀을 덮나"를 푼다(지오메트리에서 픽셀로, forward). <strong>레이트레이싱</strong>은 "픽셀마다 → 어떤 삼각형에 맞나"를 푼다(픽셀에서 지오메트리로, backward). 실시간 렌더링의 주력은 여전히 래스터화이고, 이 글은 전적으로 래스터화 이야기다.</p>
</div>

<span class="section-eyebrow" style="margin-top:40px;">1. 래스터화의 최소 골격 — tinyrenderer</span>

<p style="color:var(--text2);line-height:1.85;margin-bottom:20px;">
  래스터화가 실제로 무슨 연산인지 보려면, 군더더기 없는 구현을 한 번 읽는 게 가장 빠르다. Dmitry Sokolov의 <code>ssloy/tinyrenderer</code>는 외부 그래픽 API 없이 순수 C++로 OpenGL 파이프라인을 바닥부터 재현한 교육용 프로젝트다. 핵심 래스터화 함수는 <code>our_gl.cpp</code>의 <code>rasterize()</code> 하나에 다 들어 있다.
</p>

<div class="pipe-flow">
  <div class="pf-box"><div class="pf-step">Vertex</div><div class="pf-name">모델·뷰·투영 변환</div></div>
  <div class="pf-arrow">→</div>
  <div class="pf-box"><div class="pf-step">Clip → NDC</div><div class="pf-name">w로 나눠 정규화</div></div>
  <div class="pf-arrow">→</div>
  <div class="pf-box"><div class="pf-step">Viewport</div><div class="pf-name">화면 픽셀 좌표</div></div>
  <div class="pf-arrow">→</div>
  <div class="pf-box"><div class="pf-step">Raster</div><div class="pf-name">픽셀 커버리지 + 깊이</div></div>
  <div class="pf-arrow">→</div>
  <div class="pf-box"><div class="pf-step">Fragment</div><div class="pf-name">색 계산</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;margin-bottom:8px;">
  버텍스 셰이더가 삼각형 세 꼭짓점을 클립 공간 좌표로 넘기면, 래스터라이저는 그것을 화면 좌표로 바꾼 뒤 삼각형이 덮는 픽셀을 하나하나 찾아낸다. tinyrenderer의 구현은 <strong>바운딩 박스 + barycentric(무게중심) 좌표</strong> 방식이다.
</p>

<div class="code-cap">tinyrenderer / our_gl.cpp — rasterize()</div>
<div class="code-block"><pre>{% raw %}<span class="key">void</span> <span class="fn">rasterize</span>(<span class="key">const</span> Triangle &amp;clip, <span class="key">const</span> IShader &amp;shader, TGAImage &amp;framebuffer) {
    <span class="cmt">// 1) 클립 좌표 → w로 나눠 NDC → 뷰포트 행렬로 화면 좌표</span>
    vec4 ndc[<span class="num">3</span>]    = { clip[<span class="num">0</span>]/clip[<span class="num">0</span>].w, clip[<span class="num">1</span>]/clip[<span class="num">1</span>].w, clip[<span class="num">2</span>]/clip[<span class="num">2</span>].w };
    vec2 screen[<span class="num">3</span>] = { (Viewport*ndc[<span class="num">0</span>]).xy(), (Viewport*ndc[<span class="num">1</span>]).xy(), (Viewport*ndc[<span class="num">2</span>]).xy() };

    <span class="cmt">// 2) 삼각형 행렬의 행렬식 = 부호있는 넓이. 음수면 뒷면 → 버린다(backface cull)</span>
    mat&lt;<span class="num">3</span>,<span class="num">3</span>&gt; ABC = {{ {screen[<span class="num">0</span>].x,screen[<span class="num">0</span>].y,<span class="num">1</span>}, {screen[<span class="num">1</span>].x,screen[<span class="num">1</span>].y,<span class="num">1</span>}, {screen[<span class="num">2</span>].x,screen[<span class="num">2</span>].y,<span class="num">1</span>} }};
    <span class="key">if</span> (ABC.det()&lt;<span class="num">1</span>) <span class="key">return</span>;  <span class="cmt">// 1픽셀도 못 덮는 삼각형도 같이 걸러짐</span>

    <span class="cmt">// 3) 삼각형을 감싸는 바운딩 박스만 순회 (화면 경계로 클리핑)</span>
    <span class="key">auto</span> [bbminx,bbmaxx] = std::minmax({screen[<span class="num">0</span>].x, screen[<span class="num">1</span>].x, screen[<span class="num">2</span>].x});
    <span class="key">auto</span> [bbminy,bbmaxy] = std::minmax({screen[<span class="num">0</span>].y, screen[<span class="num">1</span>].y, screen[<span class="num">2</span>].y});
<span class="cmt">#pragma omp parallel for</span>
    <span class="key">for</span> (<span class="key">int</span> x=max(bbminx,0); x&lt;=min(bbmaxx, framebuffer.width()-<span class="num">1</span>); x++)
        <span class="key">for</span> (<span class="key">int</span> y=max(bbminy,0); y&lt;=min(bbmaxy, framebuffer.height()-<span class="num">1</span>); y++) {
            <span class="cmt">// 4) (x,y)의 barycentric 좌표. 셋 다 ≥ 0 이어야 삼각형 안쪽</span>
            vec3 bc = ABC.invert_transpose() * vec3{(double)x, (double)y, <span class="num">1</span>};
            <span class="key">if</span> (bc.x&lt;<span class="num">0</span> || bc.y&lt;<span class="num">0</span> || bc.z&lt;<span class="num">0</span>) <span class="key">continue</span>;  <span class="cmt">// 커버리지 판정</span>

            <span class="cmt">// 5) 깊이 보간 후 z-buffer 비교 (더 멀면 버림)</span>
            <span class="key">double</span> z = bc * vec3{ ndc[<span class="num">0</span>].z, ndc[<span class="num">1</span>].z, ndc[<span class="num">2</span>].z };
            <span class="key">if</span> (z &lt;= zbuffer[x+y*framebuffer.width()]) <span class="key">continue</span>;

            <span class="cmt">// 6) 살아남은 픽셀만 fragment 셰이더 실행 → 색 기록</span>
            <span class="key">auto</span> [discard, color] = shader.fragment(bc_clip);
            <span class="key">if</span> (discard) <span class="key">continue</span>;
            zbuffer[x+y*framebuffer.width()] = z;
            framebuffer.set(x, y, color);
        }
}{% endraw %}</pre></div>

<p style="color:var(--text2);line-height:1.85;margin-top:8px;">
  이 30줄 안에 래스터화의 모든 본질이 들어 있다. 정리하면 네 가지다.
</p>

<div class="term-grid">
  <div class="term-card blue">
    <div class="term-symbol">bc.x, bc.y, bc.z &gt;= 0</div>
    <div class="term-name">커버리지 판정</div>
    <p class="term-desc">픽셀 중심의 barycentric 좌표가 셋 다 0 이상이면 삼각형 내부다. 이게 "이 픽셀이 삼각형에 덮이는가"의 수학적 정의다.</p>
  </div>
  <div class="term-card teal">
    <div class="term-symbol">bc · ndc.z</div>
    <div class="term-name">깊이 보간 + z-buffer</div>
    <p class="term-desc">세 꼭짓점의 깊이를 barycentric으로 보간하고, z-buffer에 저장된 값보다 가까울 때만 통과시킨다. 가려짐(occlusion) 해결.</p>
  </div>
  <div class="term-card gold">
    <div class="term-symbol">ABC.det() &lt; 1</div>
    <div class="term-name">백페이스 컬링</div>
    <p class="term-desc">화면 좌표 삼각형의 부호있는 넓이(행렬식)가 음수면 카메라 반대쪽을 향한 면이다. 동시에 1픽셀 미만짜리도 걸러진다.</p>
  </div>
  <div class="term-card purple">
    <div class="term-symbol">bc_clip = bc / w</div>
    <div class="term-name">원근 보정 보간</div>
    <p class="term-desc">화면에서 선형인 barycentric을 그대로 UV·법선에 쓰면 원근 왜곡이 생긴다. 1/w로 가중·재정규화해 보정한다.</p>
  </div>
</div>

<div class="callout callout-purple">
  <div class="callout-title">왜 "엣지 함수"라고 부르나</div>
  <p>barycentric 좌표 하나하나는 사실 삼각형의 한 변(edge)에 대한 <strong>부호있는 거리 함수</strong>다. 변 위에서 0, 안쪽에서 양수, 바깥에서 음수가 되도록 만든 1차식 <code>E(x, y) = a·x + b·y + c</code> 이고, 이게 곧 barycentric 좌표에 비례한다. 그래서 "셋 다 ≥ 0"이 곧 "삼각형 안쪽"이 된다. 이 <strong>엣지 함수(edge function)</strong>는 1980년 Pineda가 정리한 이후 거의 모든 래스터라이저 — 하드웨어든 Nanite든 — 가 공통으로 쓰는 기본 판정 방식이다. tinyrenderer는 이것을 <code>double</code> 행렬 연산으로 풀었을 뿐이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
  중요한 관찰 하나. tinyrenderer는 <code>#pragma omp parallel for</code>로 <strong>픽셀 단위로 병렬화</strong>한다. 바운딩 박스 안의 픽셀들을 CPU 스레드에 나눠준다. 큰 삼각형이라면 픽셀이 많아 효율적이다. 하지만 삼각형이 화면에서 몇 픽셀밖에 안 된다면? 바운딩 박스 순회·셋업 비용은 그대로인데 일할 픽셀이 거의 없다. <strong>이 "작은 삼각형의 비효율"이 이 글 전체를 관통하는 주제다.</strong> 하드웨어 래스터라이저도 정확히 같은 문제를 가지고 있다.
</p>

<span class="section-eyebrow">2. 고정함수 하드웨어 래스터라이저</span>

<p style="color:var(--text2);line-height:1.85;margin-bottom:20px;">
  GPU에는 위의 <code>rasterize()</code>가 하는 일을 트랜지스터로 굳혀놓은 <strong>고정함수 유닛</strong>이 있다. 프로그래머가 건드릴 수 없고(셰이더가 아니다), 대신 압도적으로 빠르다. 동작 순서는 Fabian Giesen의 <em>"A trip through the Graphics Pipeline 2011"</em>이 가장 정확한 레퍼런스다.
</p>

<div class="pipe-flow">
  <div class="pf-box"><div class="pf-step">①</div><div class="pf-name">Primitive Assembly</div></div>
  <div class="pf-arrow">→</div>
  <div class="pf-box"><div class="pf-step">②</div><div class="pf-name">Triangle Setup<br>(엣지 방정식)</div></div>
  <div class="pf-arrow">→</div>
  <div class="pf-box"><div class="pf-step">③</div><div class="pf-name">Coarse Raster<br>(타일 단위)</div></div>
  <div class="pf-arrow">→</div>
  <div class="pf-box"><div class="pf-step">④</div><div class="pf-name">Fine Raster<br>→ 2×2 쿼드</div></div>
  <div class="pf-arrow">→</div>
  <div class="pf-box"><div class="pf-step">⑤</div><div class="pf-name">Early-Z / Hi-Z</div></div>
  <div class="pf-arrow">→</div>
  <div class="pf-box"><div class="pf-step">⑥</div><div class="pf-name">Pixel Shading</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
  ② <strong>Triangle Setup</strong>에서 세 변의 엣지 방정식(<code>E(X,Y)=aX+bY+c</code>)을 만든다. tinyrenderer가 매 픽셀마다 행렬을 푼 것을, 하드웨어는 삼각형당 한 번 계수를 셋업하고 픽셀로 가면서 덧셈만 누적한다. ③ <strong>Coarse raster</strong>는 화면을 타일(예: 8×8)로 나눠 삼각형이 닿는 타일만 추린다. ④ <strong>Fine raster</strong>가 타일 안에서 실제 덮인 픽셀을 찾는데, 이때 출력 단위가 픽셀 하나가 아니라 항상 <strong>2×2 픽셀 묶음(quad)</strong>이다.
</p>

<div class="callout callout-warn">
  <div class="callout-title">왜 항상 2×2 쿼드로 셰이딩하나 — 미분(derivative) 때문</div>
  <p>픽셀 셰이더는 텍스처를 샘플링할 때 <strong>밉맵(mip) 레벨</strong>을 골라야 한다. 밉 선택은 "화면에서 한 픽셀 옆으로 갈 때 UV가 얼마나 변하는가" — 즉 <strong>UV의 화면공간 미분(<code>ddx</code>/<code>ddy</code>)</strong>에 달려 있다. 미분을 싸게 구하는 방법은 옆 픽셀과 값을 차분(finite difference)하는 것이다. 그래서 하드웨어는 픽셀을 항상 2×2로 묶어, 같은 쿼드 안의 가로·세로 이웃끼리 차분해 미분을 추정한다. <code>ddx</code>가 거저 나오는 대신, <strong>셰이딩의 최소 단위가 픽셀 1개가 아니라 4개가 되는 비용</strong>을 치른다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
  바로 이 2×2 쿼드가 작은 삼각형에서 재앙이 된다. 삼각형이 쿼드 안의 한 픽셀만 덮어도, 하드웨어는 <strong>쿼드 네 픽셀 모두에 픽셀 셰이더를 실행</strong>한다. 덮이지 않은 나머지 픽셀들은 결과를 버리는 <strong>헬퍼 레인(helper lane)</strong>이 된다 — 미분 계산을 위해 셰이딩은 하되 출력은 안 하는 고스트 픽셀이다.
</p>

<div class="two-col">
  <div class="col-box">
    <h4>큰 삼각형 (수천 픽셀)</h4>
    <ul>
      <li><span class="li-name">셋업 비용</span><span class="li-val">삼각형당 1회 → 픽셀로 분산</span></li>
      <li><span class="li-name">쿼드 낭비</span><span class="li-val">테두리에서만 발생 (미미)</span></li>
      <li><span class="li-name">결론</span><span class="li-val" style="color:var(--teal);font-weight:600;">하드웨어가 압도적으로 유리</span></li>
    </ul>
    <p style="font-size:12px;color:var(--text2);margin-top:10px;line-height:1.65;">픽셀이 많아 셋업 비용이 묻히고, 쿼드 낭비는 삼각형 둘레에서만 생기므로 전체 대비 무시할 수준이다.</p>
  </div>
  <div class="col-box">
    <h4>마이크로폴리곤 (≈1 픽셀)</h4>
    <ul>
      <li><span class="li-name">셋업 비용</span><span class="li-val" style="color:var(--coral);">픽셀 1개에 셋업 1회 — 분산 안 됨</span></li>
      <li><span class="li-name">쿼드 낭비</span><span class="li-val" style="color:var(--coral);">4픽셀 중 1픽셀만 유효</span></li>
      <li><span class="li-name">처리율</span><span class="li-val" style="color:var(--coral);">최대 4 tris/clock에 묶임</span></li>
    </ul>
    <p style="font-size:12px;color:var(--text2);margin-top:10px;line-height:1.65;">삼각형 1개가 픽셀 1개를 덮으면 쿼드의 나머지 3개는 헬퍼 레인으로 버려진다. 셰이딩 작업의 상당 부분이 통째로 낭비된다.</p>
  </div>
</div>

<p style="color:var(--text2);line-height:1.85;">
  Giesen은 삼각형 테두리에서 생기는 쿼드 낭비를 <em>"엣지를 위해 생성된 쿼드 셰이딩 작업의 25~75%가 버려진다"</em>고 정리한다. 삼각형이 작아질수록 "테두리"가 곧 삼각형 전체가 되므로, 픽셀 1개를 덮는 극단에서는 쿼드 효율이 25%(4개 중 1개) 수준까지 떨어진다. 게다가 Giesen은 <em>"0~1개의 픽셀만 만드는 작은 삼각형이라도, 트라이앵글 셋업과 최소 한 번의 coarse·fine 래스터 단계는 반드시 거쳐야 한다"</em>고 못박는다. <strong>고정 셋업 비용 + 쿼드 낭비 + 삼각형 처리율 상한</strong>, 이 세 가지 때문에 작은 삼각형에서는 하드웨어 래스터라이저의 효율이 급격히 떨어진다.
</p>

<div class="callout callout-info">
  <div class="callout-title">Epic의 진단 (SIGGRAPH 2021)</div>
  <p><em>"작은 삼각형은 일반적인 래스터라이저 — 하드웨어 래스터라이저 포함 — 에 끔찍하다. 이들은 삼각형이 아니라 <strong>픽셀에서 고도로 병렬</strong>이 되도록 설계됐다. (…) 우리는 픽셀이 아니라 <strong>삼각형에서 wide하게</strong> 돌리고 싶다."</em></p>
  <p>한 문장으로: 하드웨어 래스터라이저는 <strong>픽셀 위에서 넓게</strong> 돌고, 마이크로폴리곤 워크로드는 <strong>삼각형 위에서 넓게</strong> 돌아야 한다. 이 불일치가 Nanite가 소프트웨어 래스터라이저를 직접 만든 동기 전부다.</p>
  <p>여기서 "넓게 돈다(run wide)"는 GPU의 수천 개 병렬 레인을 <strong>무엇으로 채우느냐</strong>를 뜻한다. 하드웨어는 삼각형 하나가 덮는 여러 <em>픽셀</em>을 레인에 펼친다 — 큰 삼각형이면 픽셀이 많아 레인이 꽉 차지만, 픽셀 1개짜리 마이크로폴리곤은 레인을 채우지 못한다. 반대로 Nanite는 레인 하나에 <em>삼각형</em> 하나를 통째로 맡긴다 — 작은 삼각형이 많을 때 비로소 레인이 꽉 찬다. 핵심은 <strong>"풍부한 쪽으로 병렬화하라"</strong>다. 큰 삼각형은 픽셀이 풍부하니 픽셀 축으로(하드웨어), 마이크로폴리곤은 삼각형이 풍부하니 삼각형 축으로(소프트웨어) 펼쳐야 레인이 놀지 않는다. 그래서 Nanite는 둘을 클러스터 크기로 갈라 쓴다.</p>
</div>

<span class="section-eyebrow">3. Nanite는 왜 소프트웨어 래스터라이저를 다시 만들었나</span>

<p style="color:var(--text2);line-height:1.85;margin-bottom:20px;">
  Nanite의 목표는 화면 픽셀당 대략 삼각형 하나, 즉 <strong>마이크로폴리곤(micropolygon)</strong> 밀도로 지오메트리를 그리는 것이다. 실제로 Nanite는 엣지 길이를 약 1픽셀로 맞추는 것을 목표로 삼는다(<code>r.Nanite.MaxPixelsPerEdge = 1.0</code>). 그러면 화면을 채우는 삼각형의 절대 다수가 픽셀 크기가 된다 — 하드웨어 래스터라이저가 원래 강점을 발휘하던 큰 삼각형 워크로드와는 정반대의 조건이다.
</p>

<div class="callout callout-teal">
  <div class="callout-title">계보 — REYES와 Visibility Buffer</div>
  <p>픽셀보다 작은 삼각형을 그린다는 발상은 새롭지 않다. Pixar의 <strong>REYES</strong>(Cook·Carpenter·Catmull, SIGGRAPH 1987)는 모든 표면을 <em>마이크로폴리곤</em>으로 잘게 다이싱(약 ½픽셀, Nyquist 기준)해 렌더링했다. Nanite의 서브픽셀 삼각형 렌더링은 이 발상의 실시간 후예다.</p>
  <p>여기에 <strong>Visibility Buffer</strong>(Burns &amp; Hunt, JCGT 2013) 아이디어가 결합된다. 두꺼운 G-buffer에 색·법선·거칠기를 다 채우는 대신, <em>"샘플당 삼각형 인덱스와 인스턴스 ID만 — 4바이트"</em>를 저장하고, 머티리얼은 나중에 그 인덱스로 복원한다. Nanite의 래스터라이저는 바로 이 visibility buffer만 채운다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
  그래서 Nanite의 래스터라이저는 색을 칠하지 않는다. 픽셀마다 <strong>"여기는 어느 클러스터의 몇 번 삼각형인가" + 깊이</strong>만 기록한다(deferred material — 머티리얼은 별도 패스에서 보이는 픽셀만). 기록할 게 ID와 깊이뿐이라 컴퓨트 셰이더로 충분하고, 2×2 쿼드도 미분도 필요 없어진다. Epic이 보고한 결과:
</p>

<div class="summary-box">
  <h3>Software Rasterization — 3× faster</h3>
  <p>Epic은 자사의 <strong>가장 빠른 primitive-shader 하드웨어 경로 대비 평균 약 3배</strong> 빠르다고 보고했다(순수 마이크로폴리곤에서는 그 이상, 구형 VS/PS 경로 대비는 훨씬 더). 단, 이 3배는 "평균·특정 비교군 기준"이라는 점을 유의 — 모든 삼각형이 아니라 <strong>작은 삼각형</strong>에서의 우위다. 그래서 Nanite는 둘을 버리지 않고, 크기에 따라 갈라 쓴다.</p>
</div>

<span class="section-eyebrow">4. Nanite 소프트웨어 래스터라이저 내부</span>

<p style="color:var(--text2);line-height:1.85;margin-bottom:20px;">
  이제 실제 코드다. 컴퓨트 셰이더 진입점은 <code>NaniteRasterizer.usf</code>의 <code>MicropolyRasterize</code>이고, 삼각형 타입이면 <code>ClusterRasterize</code>로 들어간다.
</p>

<div class="code-cap">NaniteRasterizer.usf — 진입점과 스레드 구성</div>
<div class="code-block"><pre><span class="cmt">// 정점 재사용 배치/복셀이면 32, 일반 삼각형이면 64-wide</span>
<span class="cmt">#if NANITE_VERT_REUSE_BATCH || NANITE_VOXELS</span>
    <span class="cmt">#define</span> THREADGROUP_SIZE <span class="num">32</span>
<span class="cmt">#else</span>
    <span class="cmt">#define</span> THREADGROUP_SIZE <span class="num">64</span>
<span class="cmt">#endif</span>

[numthreads(THREADGROUP_SIZE, <span class="num">1</span>, <span class="num">1</span>)]
<span class="key">void</span> <span class="fn">MicropolyRasterize</span>(uint DispatchThreadID : SV_DispatchThreadID,
                        uint GroupID : SV_GroupID, uint GroupIndex : SV_GroupIndex)
{
    <span class="cmt">// 한 스레드그룹 = 한 클러스터(최대 128 삼각형). 삼각형 타입이면:</span>
    <span class="fn">ClusterRasterize</span>( GroupID, GroupIndex );
}</pre></div>

<p style="color:var(--text2);line-height:1.85;">
  병렬화 단위가 tinyrenderer와 정반대인 점에 주목하자. tinyrenderer는 <em>픽셀</em>을 스레드에 나눴다. Nanite는 <strong>삼각형 하나를 레인 하나에</strong> 할당해 32개씩 처리한다(<code>FirstTriIndex += 32</code>). Epic이 말한 "픽셀이 아니라 삼각형 위에서 wide하게"가 이 한 줄로 구현된다. 각 레인은 자기 삼각형 하나를 셋업하고 래스터화한다.
</p>

<div class="sub-section">
  <h4>① SetupTriangle — 엣지 함수 셋업 (고정소수점)</h4>
  <p>
    tinyrenderer의 <code>ABC.det()</code>·<code>invert_transpose()</code>에 해당하는 부분이다. 다만 GPU에서 화면 좌표를 <strong>16.8 고정소수점</strong>으로 다뤄 서브픽셀 정밀도를 보장하고, 부동소수점 오차로 인접 삼각형 사이에 틈(crack)이 생기는 것을 막는다.
  </p>
</div>

<div class="code-cap">NaniteRasterizer.ush — SetupTriangle() (발췌)</div>
<div class="code-block"><pre><span class="cmt">// 세 변 벡터 (4.8 고정소수점)</span>
Tri.Edge01 = Vert0 - Vert1;
Tri.Edge12 = Vert1 - Vert2;
Tri.Edge20 = Vert2 - Vert0;

<span class="cmt">// 부호있는 넓이로 앞/뒷면 판정 — tinyrenderer의 det()와 동일한 발상</span>
<span class="key">float</span> DetXY = Tri.Edge01.y * Tri.Edge20.x - Tri.Edge01.x * Tri.Edge20.y;
Tri.bBackFace = (DetXY &gt;= <span class="num">0.0f</span>);

<span class="cmt">// 바운딩 박스 → 픽셀로 반올림. 그리고 핵심 안전장치:</span>
<span class="cmt">// 삼각형당 래스터 영역을 최대 64×64로 클램프 (작은 삼각형 전제)</span>
Tri.MaxPixel = min( Tri.MaxPixel, Tri.MinPixel + <span class="num">63</span> );

<span class="cmt">// 하프-엣지 상수 C0/C1/C2 (8.16 고정소수점) — 이게 엣지 함수의 시작값</span>
Tri.C0 = Tri.Edge12.y * Vert1.x - Tri.Edge12.x * Vert1.y;
Tri.C1 = Tri.Edge20.y * Vert2.x - Tri.Edge20.x * Vert2.y;
Tri.C2 = Tri.Edge01.y * Vert0.x - Tri.Edge01.x * Vert0.y;

<span class="cmt">// Top-left fill rule 보정 — 공유 엣지 위 픽셀이 중복/누락되지 않도록</span>
Tri.C0 -= saturate( Tri.Edge12.y + saturate( <span class="num">1.0f</span> - Tri.Edge12.x ) );
Tri.C1 -= saturate( Tri.Edge20.y + saturate( <span class="num">1.0f</span> - Tri.Edge20.x ) );
Tri.C2 -= saturate( Tri.Edge01.y + saturate( <span class="num">1.0f</span> - Tri.Edge01.x ) );

<span class="cmt">// 깊이를 평면식으로 — 픽셀에서 보간만 하면 되도록 미리 기울기 계산</span>
Tri.DepthPlane.x = Verts[<span class="num">0</span>].z;
Tri.DepthPlane.y = (Verts[<span class="num">1</span>].z - Verts[<span class="num">0</span>].z) * ScaleToUnit;
Tri.DepthPlane.z = (Verts[<span class="num">2</span>].z - Verts[<span class="num">0</span>].z) * ScaleToUnit;</pre></div>

<p style="color:var(--text2);line-height:1.85;">
  tinyrenderer에 없던 두 가지가 보인다. <strong>Top-left fill rule</strong>은 두 삼각형이 공유하는 변 위의 픽셀을 한 쪽에만 칠하기 위한 규칙이다(CPU 교육용 코드는 보통 생략하지만, 실제 래스터라이저엔 필수다 — 안 그러면 공유 엣지가 두 번 그려지거나 빈다). 그리고 <strong>64×64 클램프</strong>는 "여긴 작은 삼각형만 온다"는 전제를 코드로 박아둔 것이다 — 큰 삼각형은 어차피 하드웨어 경로로 가니까.
</p>

<div class="sub-section">
  <h4>② RasterizeTri — 엣지 함수 누적으로 픽셀 순회</h4>
  <p>
    셋업된 <code>C0/C1/C2</code>를 픽셀마다 곱셈 없이 <strong>덧셈만으로 갱신</strong>하며 커버리지를 판정한다. 한 칸 옆으로 가면 엣지값에서 <code>Edge.y</code>를 빼고, 한 줄 내려가면 <code>Edge.x</code>를 더한다. 커버리지 판정은 tinyrenderer와 글자 그대로 같다: <code>min3(C0, C1, C2) &gt;= 0</code>.
  </p>
</div>

<div class="code-cap">NaniteRasterizer.ush — RasterizeTri_Scanline() (핵심 루프)</div>
<div class="code-block"><pre>{
    <span class="cmt">// 각 스캔라인에서 엣지 함수를 풀어 좌우 교차점 x0, x1을 직접 계산</span>
    <span class="cmt">// (바운딩박스 전체를 훑지 않고, 실제 덮인 구간만 순회 → 낭비 최소화)</span>
    <span class="key">float3</span> CrossX = <span class="key">float3</span>( CY0, CY1, CY2 ) * InvEdge012;
    <span class="key">float</span> x0 = ceil( max3( MinX.x, MinX.y, MinX.z ) );
    <span class="key">float</span> x1 =        min3( MaxX.x, MaxX.y, MaxX.z );

    <span class="key">float</span> CX0 = CY0 - x0 * Tri.Edge12.y;
    <span class="key">float</span> CX1 = CY1 - x0 * Tri.Edge20.y;
    <span class="key">float</span> CX2 = CY2 - x0 * Tri.Edge01.y;

    <span class="key">for</span> (<span class="key">float</span> x = x0; x &lt;= x1; x++) {
        <span class="cmt">// 커버리지 판정 — tinyrenderer의 (bc.x|y|z &lt; 0) continue 와 동일</span>
        <span class="key">if</span> (min3(CX0, CX1, CX2) &gt;= <span class="num">0</span>)
            <span class="fn">WritePixel</span>(uint2(x, y), <span class="key">float3</span>(CX0, CX1, CX2), Tri);

        CX0 -= Tri.Edge12.y;  <span class="cmt">// 곱셈 없이 덧셈만으로 다음 픽셀 엣지값 갱신</span>
        CX1 -= Tri.Edge20.y;
        CX2 -= Tri.Edge01.y;
    }
    CY0 += Tri.Edge12.x; CY1 += Tri.Edge20.x; CY2 += Tri.Edge01.x;  <span class="cmt">// 다음 줄</span>
    y++;
}</pre></div>

<p style="color:var(--text2);line-height:1.85;">
  Nanite는 삼각형 모양에 따라 래스터화 루프를 골라 쓴다(<code>RasterizeTri_Adaptive</code>). 폭이 4픽셀을 넘거나 픽셀 프로그래머블이면 위의 <strong>스캔라인</strong> 방식을, 더 작으면 바운딩 사각형을 그냥 훑는 <code>RasterizeTri_Rect</code>를 쓴다. 마이크로폴리곤은 보통 후자다 — 몇 픽셀 안 되니 분기 비용이 더 아깝다.
</p>

<div class="sub-section">
  <h4>③ WritePixel — 64비트 VisBuffer와 InterlockedMax 깊이 테스트</h4>
  <p>
    여기가 가장 영리한 부분이다. tinyrenderer는 <code>zbuffer[i]</code>를 읽고-비교하고-쓰는 3단계를 했다. 단일 스레드라 안전했다. 하지만 GPU에선 수천 레인이 같은 픽셀에 동시에 쓸 수 있다 — 락 없이 어떻게 "가장 가까운 게 이긴다"를 보장할까?
  </p>
</div>

<p style="color:var(--text2);line-height:1.85;">
  Nanite의 답: 깊이와 페이로드를 <strong>하나의 64비트 정수로 패킹</strong>하되, <strong>깊이를 상위 32비트에 둔다.</strong> 그리고 그 정수에 <code>InterlockedMax</code> 하나만 때린다. 깊이가 상위 비트에 있으니 정수 비교에서 깊이가 우선하고, atomic max는 <strong>"읽기·비교·쓰기"를 하나의 분할 불가능한 연산으로</strong> 처리한다. z-buffer 비교와 기록이 한 번에, 락 없이 끝난다.
</p>

<div class="code-cap">NaniteWritePixel.ush / D3DCommon.ush — 패킹과 atomic</div>
<div class="code-block"><pre><span class="cmt">// 하위 32비트 = 페이로드 (클러스터 인덱스 + 삼각형 인덱스)</span>
<span class="cmt">//   ((VisibleClusterIndex + 1) &lt;&lt; 8) | TriIndex   ← 하위 8비트가 삼각형 번호</span>
<span class="cmt">// 상위 32비트 = asuint(Depth), 즉 깊이 float의 비트패턴</span>
UlongType <span class="fn">PackUlongType</span>(uint2 Value) {  <span class="cmt">// Value = (PixelValue, DepthInt)</span>
    <span class="key">return</span> ((UlongType)Value.y &lt;&lt; <span class="num">32</span>) | Value.x;   <span class="cmt">// 깊이가 상위 비트로</span>
}

<span class="cmt">// 깊이 테스트 + 기록을 단 한 번의 atomic으로</span>
<span class="key">void</span> <span class="fn">ImageInterlockedMaxUInt64</span>(RWTexture2D&lt;UlongType&gt; Dest, uint2 Coord, UlongType Value) {
    InterlockedMax(Dest[Coord], Value);
}

<span class="cmt">// WritePixel 내부:</span>
<span class="key">const</span> UlongType Pixel = <span class="fn">PackUlongType</span>(uint2(PixelValue, DepthInt));
<span class="fn">ImageInterlockedMaxUInt64</span>(OutVisBuffer64, PixelPos, Pixel);</pre></div>

<div class="callout callout-info">
  <div class="callout-title">왜 Max가 곧 깊이 테스트인가</div>
  <p>UE는 <strong>reversed-Z</strong>를 쓴다 — 가까울수록 깊이값(의 float 비트패턴)이 <strong>크다</strong>. 깊이가 상위 32비트에 있으니, 두 64비트 값을 부호 없는 정수로 비교하면 깊이가 먼저 비교된다. 따라서 <code>InterlockedMax</code>로 더 큰 값을 남기면 <strong>가장 가까운 프래그먼트가 자동으로 이긴다.</strong> 여러 레인이 같은 픽셀에 동시에 써도 하드웨어 atomic이 직렬화를 보장하므로, 별도의 락이나 depth buffer 없이 깊이 테스트가 공짜로 따라온다. SIGGRAPH 2021 강연 기준 패킹은 <code>깊이 30 : 클러스터 27 : 삼각형 7</code>비트였고, 5.7.4 소스는 64비트 안에서 <strong>상위 32비트 깊이 + 하위 32비트 페이로드(삼각형 8비트 포함)</strong> 형태다(버전에 따라 비트 배분은 달라진다).</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
  머티리얼이 마스킹(<code>Masked</code>)이나 PDO를 쓰는 클러스터만 예외적으로, atomic 쓰기 전에 <code>EarlyDepthTest()</code>로 미리 깊이를 확인해 어차피 가려질 픽셀의 비싼 머티리얼 평가를 건너뛴다. 그 외 대부분의 클러스터는 래스터화 중 아무 머티리얼 연산도 하지 않는다 — ID와 깊이만 쓰고 끝이다.
</p>

<span class="section-eyebrow">5. SW냐 HW냐 — 경로는 어떻게 갈리는가</span>

<p style="color:var(--text2);line-height:1.85;margin-bottom:20px;">
  Nanite는 소프트웨어 래스터라이저로 하드웨어를 <strong>대체</strong>하지 않는다. 큰 삼각형은 여전히 하드웨어가 압도적으로 유리하기 때문이다. 그래서 <strong>클러스터마다</strong> 둘 중 하나를 고른다. 판정은 컬링 단계의 <code>SmallEnoughToDraw()</code>에서 일어나고, 결과는 <code>bUseHWRaster</code> 플래그로 나온다.
</p>

<div class="code-cap">NaniteClusterCulling.usf — SmallEnoughToDraw()</div>
<div class="code-block"><pre><span class="key">bool</span> <span class="fn">SmallEnoughToDraw</span>( ..., <span class="key">float</span> EdgeLength, <span class="key">inout bool</span> bUseHWRaster )
{
    <span class="key">float</span> ProjectedEdgeScale = <span class="fn">GetProjectedEdgeScales</span>( ... ).x;

    <span class="key">if</span> (RenderFlags &amp; NANITE_RENDER_FLAG_FORCE_HW_RASTER) {
        bUseHWRaster = <span class="key">true</span>;
    } <span class="key">else</span> {
        <span class="key">float</span> HWEdgeScale = InstanceData.NonUniformScale.w * Bounds.NodeMaxDeformScale;
        <span class="cmt">// 화면상 엣지가 충분히 "크면" 하드웨어로. (ProjectedEdgeScale은</span>
        <span class="cmt">// 겉보기 크기에 반비례 — 값이 작을수록 화면에서 큰 삼각형)</span>
        bUseHWRaster |= ProjectedEdgeScale &lt; HWEdgeScale * abs(EdgeLength) * NaniteView.LODScaleHW;
    }
    ...
}</pre></div>

<p style="color:var(--text2);line-height:1.85;">
  임계값을 정하는 CVar가 핵심이다. Epic 자신의 주석이 가장 명확하다.
</p>

<div class="key-fact">
r.Nanite.MaxPixelsPerEdge   = 1.0&nbsp;&nbsp;&nbsp;<span style="color:var(--text3)">// Nanite가 목표하는 삼각형 엣지 길이(픽셀)</span><br>
r.Nanite.MinPixelsPerEdgeHW = 32.0&nbsp;&nbsp;<span style="color:var(--text3)">// "Nanite가 하드웨어 래스터라이저를 쓰기 시작하는 엣지 픽셀 길이"</span>
</div>

<p style="color:var(--text2);line-height:1.85;">
  즉 화면상 엣지 길이가 <strong>약 32픽셀 이상으로 큰 삼각형은 하드웨어</strong>, 그보다 작으면 <strong>소프트웨어</strong>로 간다. Nanite는 엣지를 1픽셀로 다이싱하는 게 목표이므로(<code>MaxPixelsPerEdge=1</code>), 실제 장면에서는 <strong>절대 다수의 클러스터가 소프트웨어 경로</strong>를 탄다. 하드웨어 경로는 카메라에 아주 가까워 크게 보이는 면들이 주로 쓴다. (참고로 이 임계값을 거꾸로 — 작은 삼각형이 하드웨어로 간다고 — 설명한 자료가 종종 보이는데, 부등식과 CVar 주석 모두 위 방향이 맞다.)
</p>

<div class="sub-section">
  <h4>Binning과 디스패치 — 두 리스트로 분리</h4>
  <p>
    <code>bUseHWRaster</code> 플래그가 정해지면 <code>NaniteRasterBinning.usf</code>가 클러스터를 SW 리스트와 HW 리스트로 나눠 담고(<code>SWCount</code>/<code>HWCount</code>를 atomic으로 카운트), 각 경로의 <strong>indirect 인자</strong>를 만든다. SW는 <code>MicropolyRasterize</code>를 도는 <strong>indirect dispatch(컴퓨트)</strong>로, HW는 <strong>indirect draw</strong>로 나간다. HW 경로는 GPU 세대에 따라 일반 VS/PS, primitive shader, mesh shader 중 하나를 쓴다.
  </p>
</div>

<p style="color:var(--text2);line-height:1.85;">
  결정적으로, <strong>두 경로의 출력은 같다.</strong> 하드웨어 경로의 픽셀 셰이더 <code>HWRasterizePS</code>도 소프트웨어 경로의 <code>PlotPixel</code>도, 똑같은 <code>FVisBufferPixel::Write()</code>를 호출해 <strong>같은 64비트 VisBuffer에 같은 InterlockedMax</strong>로 기록한다. 즉 래스터화 방법만 다를 뿐, "VisBuffer에 Depth+클러스터+삼각형 ID를 원자적으로 남긴다"는 결과는 완전히 동일하다. 덕분에 이후 머티리얼 셰이딩 패스는 어느 경로로 그려졌는지 신경 쓸 필요가 없다.
</p>

<table class="mapping-table">
  <thead>
    <tr><th>항목</th><th>하드웨어 경로</th><th>소프트웨어 경로</th></tr>
  </thead>
  <tbody>
    <tr><td class="desc-cell">대상 클러스터</td><td>화면상 엣지 큰 삼각형 (≥ ~32px)</td><td class="desc-cell" style="color:var(--teal);font-weight:600;">작은 삼각형 (대부분)</td></tr>
    <tr><td class="desc-cell">진입점</td><td class="mono-cell">HWRasterizeVS / PS</td><td class="mono-cell">MicropolyRasterize</td></tr>
    <tr><td class="desc-cell">디스패치</td><td>indirect draw (VS/PS·prim·mesh)</td><td>indirect dispatch (compute)</td></tr>
    <tr><td class="desc-cell">래스터화 주체</td><td>고정함수 유닛</td><td>컴퓨트 엣지 함수 (레인당 삼각형 1개)</td></tr>
    <tr><td class="desc-cell">셰이딩 단위</td><td>2×2 쿼드 (헬퍼 레인 발생)</td><td>픽셀/스캔라인 (낭비 없음)</td></tr>
    <tr><td class="desc-cell">출력</td><td class="mono-cell">VisBuffer64 ← Pixel.Write()</td><td class="mono-cell">VisBuffer64 ← Pixel.Write()</td></tr>
  </tbody>
</table>

<span class="section-eyebrow">6. 정리 — tinyrenderer ↔ Nanite</span>

<p style="color:var(--text2);line-height:1.85;margin-bottom:8px;">
  같은 엣지 함수 래스터화가, 30줄짜리 교육용 CPU 코드에서 출발해 수억 폴리곤을 실시간으로 그리는 GPU 시스템까지 어떻게 확장되는지 한눈에 비교하면 다음과 같다.
</p>

<table class="mapping-table">
  <thead>
    <tr><th>개념</th><th>tinyrenderer (CPU)</th><th>Nanite SW 래스터 (GPU 컴퓨트)</th></tr>
  </thead>
  <tbody>
    <tr><td class="desc-cell">병렬화 단위</td><td>픽셀 (OpenMP)</td><td class="desc-cell" style="color:var(--accent);font-weight:600;">삼각형 1개 = 레인 1개</td></tr>
    <tr><td class="desc-cell">커버리지 판정</td><td class="mono-cell">bc.x|y|z &gt;= 0</td><td class="mono-cell">min3(C0,C1,C2) &gt;= 0</td></tr>
    <tr><td class="desc-cell">좌표 정밀도</td><td>double</td><td>16.8 고정소수점 + top-left rule</td></tr>
    <tr><td class="desc-cell">깊이 테스트</td><td>zbuffer 읽기-비교-쓰기 (단일 스레드)</td><td class="desc-cell" style="color:var(--teal);font-weight:600;">64비트 InterlockedMax (락-프리)</td></tr>
    <tr><td class="desc-cell">출력</td><td>framebuffer 색상</td><td>VisBuffer (Depth | Cluster | Tri)</td></tr>
    <tr><td class="desc-cell">셰이딩 시점</td><td>즉시 (fragment 호출)</td><td>지연 (별도 머티리얼 패스)</td></tr>
    <tr><td class="desc-cell">삼각형 크기 전제</td><td>임의</td><td>작음 (≤ 64×64, 큰 건 HW로)</td></tr>
  </tbody>
</table>

<div class="summary-box">
  <h3>한 문장 요약</h3>
  <p>래스터화의 핵심은 <strong>픽셀이 삼각형 안에 있는지 엣지 함수로 판정하는 것</strong>이다. 하드웨어 래스터라이저는 픽셀 단위 병렬화와 2×2 쿼드 셰이딩에 최적화돼 큰 삼각형에는 강하지만, 픽셀 크기의 작은 삼각형이 많아지면 셋업 비용과 헬퍼 레인 낭비 때문에 느려진다. Nanite는 이런 작은 삼각형을 컴퓨트 셰이더에서 <strong>삼각형 단위로 병렬 처리</strong>하고, 우선 각 픽셀에 보이는 삼각형 ID와 깊이만 Visibility Buffer에 기록한 뒤, 나중에 실제로 보이는 픽셀만 머티리얼 셰이딩한다.</p>
</div>

<span class="section-eyebrow">참고자료</span>

<ul class="ref-list">
  <li><span class="ref-tag">[소스]</span> ssloy/tinyrenderer — <code>our_gl.cpp</code>, <code>main.cpp</code> (래스터화·셰이딩 골격). <a href="https://github.com/ssloy/tinyrenderer">github.com/ssloy/tinyrenderer</a> · 위키 강의 Lesson 0–8</li>
  <li><span class="ref-tag">[소스]</span> Unreal Engine 5.7.4 — <code>NaniteRasterizer.ush/.usf</code>, <code>NaniteRasterizationCommon.ush</code>, <code>NaniteWritePixel.ush</code>, <code>NaniteClusterCulling.usf</code>, <code>NaniteRasterBinning.usf</code>, <code>NaniteCullRaster.cpp</code></li>
  <li><span class="ref-tag">[강연]</span> Brian Karis, Rune Stubbe, Graham Wihlidal, <em>"A Deep Dive into Nanite Virtualized Geometry"</em>, SIGGRAPH 2021 Advances in Real-Time Rendering. <a href="https://advances.realtimerendering.com/s2021/">advances.realtimerendering.com/s2021</a> (소프트웨어 래스터 "3× faster" 슬라이드, "wide over triangles" 진단, 비트 패킹 30:27:7)</li>
  <li><span class="ref-tag">[기초]</span> Fabian Giesen, <em>"A trip through the Graphics Pipeline 2011"</em> Part 5–8 (트라이앵글 셋업, 2×2 쿼드, 미분, early-Z, 쿼드 낭비 25–75%). <a href="https://fgiesen.wordpress.com/2011/07/09/a-trip-through-the-graphics-pipeline-2011-index/">fgiesen.wordpress.com</a></li>
  <li><span class="ref-tag">[논문]</span> Christopher A. Burns, Warren A. Hunt, <em>"The Visibility Buffer: A Cache-Friendly Approach to Deferred Shading"</em>, JCGT Vol.2 No.2, 2013. <a href="https://jcgt.org/published/0002/02/04/">jcgt.org</a></li>
  <li><span class="ref-tag">[논문]</span> Cook, Carpenter, Catmull, <em>"The Reyes Image Rendering Architecture"</em>, SIGGRAPH 1987 (마이크로폴리곤의 기원)</li>
  <li><span class="ref-tag">[배경]</span> Stephen Hill, <em>"Counting Quads"</em> (쿼드 오버드로/오버셰이딩 측정). <a href="https://blog.selfshadow.com/2012/11/12/counting-quads/">blog.selfshadow.com</a></li>
</ul>

</div>
