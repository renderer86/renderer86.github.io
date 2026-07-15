---
layout: post
title: "GPU Lightmass: 렌더링 방정식을 오프라인에 굽다 — 텍셀당 패스 트레이싱에서 SH 라이트맵 인코딩, Lumen과의 물리성 비교까지"
icon: paper
permalink: gpu-lightmass
categories: Rendering
tags: [ComputerGraphics, Rendering, UnrealEngine, GlobalIllumination, GPULightmass, PathTracing, Lightmap, Lumen, MonteCarlo]
excerpt: "GPU Lightmass는 라이트맵 텍셀 하나하나를 '카메라'로 삼아 DXR 하드웨어 레이 트레이싱으로 몬테카를로 패스 트레이싱을 돌리는 오프라인 베이커다. 이 글은 UE 5.8 소스(LightmapPathTracing.usf)를 따라 텍셀당 512개 경로가 NEE·MIS·러시안 룰렛으로 렌더링 방정식의 적분항을 추정하는 과정, 그 결과가 조도/π + SH 방향성으로 인코딩되어 베이스 패스의 디퓨즈 항에만 곱해지는 경로를 코드로 추적한다. 마지막으로 Surface Cache 피드백 루프로 GI를 근사하는 Lumen과 나란히 놓고 — 오차가 '노이즈'로 나타나는 쪽과 '체계적 편향'으로 나타나는 쪽 — 어느 쪽이 렌더링 방정식에 더 충실한지 따져본다."
back_color: "#ffffff"
img_name: "volumetric-lightmap-sh-sketch-white.webp"
toc: false
show: true
new: true
series: -1
index: 22
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 라이트맵을 "굽는다"는 게 수식으로 정확히 무엇을 계산하는 일인지 궁금한 분
> - GPU Lightmass가 렌더링 방정식의 어느 항을 담당하고, 구운 결과가 최종 픽셀 색의 어디에 더해지는지 코드로 확인하고 싶은 분
> - 레거시 CPU Lightmass(포톤 매핑)와 GPU Lightmass(패스 트레이싱)가 알고리즘부터 다르다는 걸 짚고 싶은 분
> - 라이트맵에 알베도가 왜 안 들어가는지, 방향성(directionality) SH가 노멀맵과 어떻게 만나는지 궁금한 분
> - Lumen과 GPU Lightmass 중 "뭐가 더 물리 기반이냐"는 질문에 bias/noise 관점의 답을 원하는 분
>
> **이 글로 알 수 있는 내용**
>
> - 카지야 렌더링 방정식의 적분항을 몬테카를로로 추정하는 공식과, GPU Lightmass가 텍셀에 저장하는 값의 정확한 정체 — **조도(irradiance)/π**
> - `LightmapPathTracing.usf`의 `PathTracingKernel` 해부 — 텍셀을 albedo=1 램버시안 표면으로 두는 가짜 카메라 광선, 최대 32 바운스, NEE + MIS, 러시안 룰렛
> - Irradiance Caching과 First Bounce Ray Guiding이 무엇을 얻고 무엇("편향 없음")을 내주는지
> - 컬러 라이트맵 = 간접광(전체) + 직접광(Static 전용), Stationary 직접광은 별도 섀도마스크 — 이 분리가 코드 어디서 일어나는지
> - LogLUVW 색 + L1 SH 방향성 인코딩, 그리고 베이스 패스에서 `DiffuseColor × 라이트맵`으로 **디퓨즈 항에만** 더해지는 런타임 경로
> - 움직이는 오브젝트를 위한 볼류메트릭 라이트맵(3밴드 SH 브릭)
> - Lumen의 Surface Cache·스크린 프로브·시간 누적 구조와의 정면 비교, 그리고 "물리 기반" 논쟁의 정리

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Nanum+Pen+Script&display=swap" rel="stylesheet">

<style>
.gplm-post {
  --bg2: #faf6f0;
  --surface: #fbf8f3;
  --surface2: #f4ede2;
  --border: rgba(180,83,9,0.12);
  --border2: rgba(180,83,9,0.26);
  --text: #221a12;
  --text2: #4a4038;
  --text3: #8a7f74;
  --accent: #b45309;
  --accent2: #6d28d9;
  --gold: #b07d00;
  --teal: #0a8f72;
  --coral: #d6304a;
}
.gplm-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.gplm-post .callout {
  border-radius: 12px;
  padding: 18px 22px;
  margin: 24px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.gplm-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.gplm-post .callout-info { background: rgba(180,83,9,0.05); border-color: rgba(180,83,9,0.18); }
.gplm-post .callout-info::before { background: var(--accent); }
.gplm-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.gplm-post .callout-warn::before { background: var(--gold); }
.gplm-post .callout-purple { background: rgba(109,40,217,0.05); border-color: rgba(109,40,217,0.18); }
.gplm-post .callout-purple::before { background: var(--accent2); }
.gplm-post .callout-title {
  font-size: 12px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; margin-bottom: 6px;
}
.gplm-post .callout-info .callout-title { color: var(--accent); }
.gplm-post .callout-warn .callout-title { color: var(--gold); }
.gplm-post .callout-purple .callout-title { color: var(--accent2); }
.gplm-post .callout p { margin: 0; font-size: 14px; color: var(--text2); line-height: 1.78; }
.gplm-post .callout p + p { margin-top: 10px; }
.gplm-post .data-table { overflow-x: auto; margin: 24px 0; }
.gplm-post .data-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
.gplm-post .data-table th {
  padding: 10px 14px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--accent);
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
}
.gplm-post .data-table td { padding: 9px 14px; border: 1px solid var(--border); color: var(--text2); line-height: 1.65; vertical-align: top; }
.gplm-post .data-table tr:nth-child(even) td { background: var(--surface); }
.gplm-post .data-table code { font-size: 12px; }
.gplm-post .formula {
  background: var(--surface2);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 16px 20px;
  margin: 18px 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 13.5px;
  color: var(--text);
  overflow-x: auto;
  white-space: normal;
  line-height: 2.0;
}
.gplm-post .formula .katex-display { margin: 0.35em 0; overflow-x: auto; overflow-y: hidden; padding: 0.2em 0; }
.gplm-post .formula .katex { font-size: 1.12em; }
.gplm-post .formula-label { color: var(--accent); font-family: inherit; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; }
.gplm-post .formula-label.formula-label-next { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }
.gplm-post .formula-note { margin-top: 8px; color: var(--text3); font-family: inherit; font-size: 12px; text-align: center; line-height: 1.6; }
.gplm-post .eq-anno-wrap { background: var(--surface2); border: 1px solid var(--border2); border-radius: 10px; padding: 28px 26px 16px; margin: 18px 0 28px; overflow-x: auto; }
.gplm-post .eq-anno { display: flex; align-items: flex-start; gap: 10px; min-width: max-content; font-family: 'STIX Two Math', 'Cambria Math', Georgia, serif; font-size: 19px; color: var(--text); padding: 0 4px; }
.gplm-post .eq-anno .op { padding-top: 3px; color: var(--text2); flex-shrink: 0; }
.gplm-post .eq-anno .term { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
.gplm-post .eq-anno .t-formula { white-space: nowrap; padding: 0 3px; }
.gplm-post .eq-anno .t-line { width: 100%; height: 9px; margin-top: 4px; display: block; }
.gplm-post .eq-anno .t-label { font-family: 'Nanum Pen Script', cursive; font-size: 18px; line-height: 1.2; margin-top: 3px; text-align: center; white-space: nowrap; }
.gplm-post .eq-anno-wrap .formula-label { margin-bottom: 14px; }
.gplm-post .eq-anno .frac { display: inline-flex; flex-direction: column; align-items: center; line-height: 1.2; font-size: 0.9em; vertical-align: middle; }
.gplm-post .eq-anno .frac .fr-t { padding: 0 5px 1px; border-bottom: 1.3px solid var(--text); }
.gplm-post .eq-anno .frac .fr-b { padding: 1px 5px 0; }
.gplm-post .eq-anno-wrap .formula-note { margin-top: 14px; }
.gplm-post .formula-breakdown { text-align: left; }
.gplm-post .formula-breakdown div + div { margin-top: 3px; }
.gplm-post .formula-breakdown strong { color: var(--text2); }
.gplm-post .formula .f-term { color: var(--accent); font-weight: 600; }
.gplm-post .formula .f-int { color: var(--gold); }
.gplm-post .formula .f-fn { color: var(--teal); font-weight: 600; }
.gplm-post .formula .f-dim { color: var(--text3); }
.gplm-post .code-block {
  background: #211b14;
  border: 1px solid rgba(220,160,90,0.16);
  border-radius: 12px;
  padding: 20px 22px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.8;
  overflow-x: auto;
  margin: 20px 0;
  position: relative;
  white-space: pre;
  color: #e2d5c3;
}
.gplm-post .code-block .kw { color: #c4b5fd; }
.gplm-post .code-block .fn { color: #5eead4; }
.gplm-post .code-block .cm { color: #7d6f5c; font-style: italic; }
.gplm-post .code-block .num { color: #fb923c; }
.gplm-post .code-lang {
  position: absolute; top: 10px; right: 14px;
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #7d6f5c;
}
.gplm-post .scene-fig {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 22px 20px;
  margin: 26px 0;
}
.gplm-post .scene-fig svg { width: 100%; height: auto; display: block; }
.gplm-post .scene-fig img { width: 100%; height: auto; display: block; border-radius: 10px; }
.gplm-post .scene-cap { font-size: 12px; color: var(--text3); text-align: center; margin-top: 14px; line-height: 1.65; }
.gplm-post .vs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 24px 0; }
@media (max-width: 640px) { .gplm-post .vs-grid { grid-template-columns: 1fr; } }
.gplm-post .vs-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.gplm-post .vs-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; }
.gplm-post .vs-card.bake::before { background: var(--accent); }
.gplm-post .vs-card.lumen::before { background: var(--accent2); }
.gplm-post .vs-card h4 { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
.gplm-post .vs-card.bake h4 { color: var(--accent); }
.gplm-post .vs-card.lumen h4 { color: var(--accent2); }
.gplm-post .vs-card p { font-size: 13px; color: var(--text2); line-height: 1.7; margin: 0 0 8px; }
.gplm-post .vs-card p:last-child { margin-bottom: 0; }
.gplm-post .summary-box {
  background: linear-gradient(135deg, rgba(180,83,9,0.06) 0%, rgba(109,40,217,0.06) 100%);
  border: 1px solid rgba(180,83,9,0.18);
  border-radius: 16px;
  padding: 32px;
  margin: 32px 0;
}
.gplm-post .summary-box h3 { font-size: 1.2rem; font-weight: 700; margin-bottom: 12px; color: var(--text); }
.gplm-post .summary-box p { margin: 0 0 12px; font-size: 15px; line-height: 1.85; color: var(--text2); }
.gplm-post .summary-box p:last-child { margin-bottom: 0; }
</style>

<div class="gplm-post">
<span class="section-eyebrow" style="margin-top:0;">00 — 개요</span>
</div>

# GPU Lightmass는 "텍셀마다 렌더링 방정식을 푸는" 오프라인 패스 트레이서다

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
라이트맵을 "굽는다(bake)"는 표현은 오해를 부른다. 마치 미리 그려둔 그림자 텍스처를 붙이는 것처럼 들리지만, 실제로 일어나는 일은 훨씬 근본적이다 — <strong>라이트맵 텍셀 하나하나에 대해 렌더링 방정식의 적분을 수치적으로 푸는 것</strong>이다. UE5의 GPU Lightmass(GPULM)는 이 적분을 DXR 하드웨어 레이 트레이싱 위의 <strong>몬테카를로 패스 트레이싱</strong>으로 계산한다. 텍셀 하나당 기본 512개의 광선 경로를 쏘고, 각 경로가 씬을 최대 32번 튕기며 모아온 빛을 평균 내서, 그 값을 텍스처에 저장한다. 화면 픽셀 대신 라이트맵 텍셀을 "카메라"로 삼는 오프라인 렌더러인 셈이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이름 때문에 레거시 <strong>CPU Lightmass</strong>의 GPU 포팅으로 오해하기 쉽지만, <strong>솔버(solver)</strong> — 렌더링 방정식의 적분을 실제로 계산해내는 알고리즘 — 자체가 다르다. 입력(씬·라이트)과 출력(라이트맵)은 같아도 푸는 방법이 다른 것이다. CPU Lightmass는 <strong>포톤 매핑</strong> 계열이다: 먼저 광원에서 수많은 "포톤"(빛 입자)을 씬에 쏘아 표면에 쌓아두고, 그다음 각 텍셀이 주변에 쌓인 포톤 밀도를 수집해 간접광을 추정한다 — 뿌리고 수집하는 2단계 방식이라 결과가 포톤 개수와 수집 반경에 의존하고, 오차가 노이즈가 아닌 "번짐"으로 나타나는 편향된 방법이다. GPU Lightmass는 방향이 반대다 — <strong>텍셀에서 출발한 경로가 빛이 온 길을 거꾸로 되짚어 광원까지 간다.</strong> 포톤맵 같은 중간 자료구조도 없어서 플러그인 어디에도 포톤은 없고, <code>LightmapPathTracing.usf</code> 셰이더가 엔진의 레퍼런스 패스 트레이서(<code>Engine/Shaders/Private/PathTracing/</code>)의 재질 평가·광원 샘플링 라이브러리를 그대로 끌어다 쓰는, 무비 렌더러와 같은 계열의 <strong>path tracer</strong>다. Frostbite의 라이트맵 베이커 Flux(GDC 2018)도 똑같은 방식을 택했다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 글은 두 부분으로 나뉜다. 전반부(01–07장)에서는 <strong>GPU Lightmass가 어떤 공식으로 라이팅 값을 만들어내고, 그 값이 렌더링 방정식의 어느 항이 되어 최종 화면에 더해지는지</strong>를 UE 5.8 소스로 추적한다. 후반부(08–09장)에서는 같은 방정식을 실시간으로 근사하는 <strong>Lumen과 무엇이 다르고, 어느 쪽이 더 "물리 기반"인지</strong>를 따진다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>UE 5.8 소스를 직접 읽고 정리했다 — 베이커: <code>Engine/Plugins/Experimental/GPULightmass/</code>의 <code>LightmapPathTracing.usf</code> · <code>LightmapEncoding.ush</code> · <code>LightmapOutput.usf</code> · <code>IrradianceCachingCommon.ush</code> · <code>GPULightmassSettings.h</code> · <code>LightmapRenderer.cpp</code> · <code>LightmapEncoding.cpp</code>, 런타임: <code>Engine/Shaders/Private/LightmapCommon.ush</code> · <code>BasePassPixelShader.usf</code>, Lumen: <code>Engine/Shaders/Private/Lumen/</code> 일대. 외부 자료는 Epic 공식 문서(GPU Lightmass / Lumen Technical Details), Kajiya의 1986년 원 논문, Daniel Wright의 SIGGRAPH 2021 "Radiance Caching for Real-Time Global Illumination"과 SIGGRAPH 2022 Lumen 발표, Frostbite GDC 2018 "Precomputed Global Illumination in Frostbite"를 교차 확인했다. GPU Lightmass는 5.8에서도 여전히 Experimental 플러그인이다.</p>
</div>

<span class="section-eyebrow">01 — 공식</span>
</div>

# 어떤 공식으로 라이팅 값을 만드나 — 렌더링 방정식의 몬테카를로 추정

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
출발점은 언제나 카지야(1986)의 렌더링 방정식이다. 표면 위 한 점 x에서 방향 ω<sub>o</sub>로 나가는 빛은, 스스로 내는 빛과 사방에서 들어온 빛을 재질이 되돌려 보내는 양의 합이다.
</p>

<div class="eq-anno-wrap">
<div class="eq-anno">
<span class="term">
<span class="t-formula"><i>L</i><sub>o</sub>(<i>x</i>, <i>ω</i><sub>o</sub>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 26 2, 52 5 T 97 4" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">나가는 빛<br>= 구하려는 값</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><i>L</i><sub>e</sub>(<i>x</i>, <i>ω</i><sub>o</sub>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4 Q 30 6.5, 55 3.5 T 97 5" fill="none" stroke="#d6304a" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#d6304a;">자발광<br>(스스로 내는 빛, 없으면 0)</span>
</span>
<span class="op">+</span>
<span class="term">
<span class="t-formula"><span style="font-size:1.4em;">∫</span><sub>Ω⁺(<b>n</b>)</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5 Q 28 2.5, 54 5.5 T 97 3.5" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">법선 위 반구의<br>모든 방향에 대해 적분</span>
</span>
<span class="term">
<span class="t-formula"><i>f</i><sub>r</sub>(<i>x</i>, <i>ω</i><sub>i</sub>, <i>ω</i><sub>o</sub>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4.5 Q 25 7, 50 4 T 97 5.5" fill="none" stroke="#0a8f72" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#0a8f72;">BRDF — 재질의 반사 특성<br>(디퓨즈면 ρ/π 상수)</span>
</span>
<span class="term">
<span class="t-formula"><i>L</i><sub>i</sub>(<i>x</i>, <i>ω</i><sub>i</sub>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 27 3, 53 6 T 97 4" fill="none" stroke="#6d28d9" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#6d28d9;">들어오는 빛<br>= 다른 표면의 <i>L</i><sub>o</sub> (재귀!)</span>
</span>
<span class="term">
<span class="t-formula">(<b>n</b> · <i>ω</i><sub>i</sub>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4 Q 29 6, 55 3.5 T 97 5" fill="none" stroke="#3d63e0" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#3d63e0;">= cosθ, 코사인 감쇠<br>비스듬히 오면 약해진다</span>
</span>
<span class="term">
<span class="t-formula">d<i>ω</i><sub>i</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M6 5 Q 40 3, 60 5.5 T 94 4.5" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">∫의 짝</span>
</span>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
문제는 언제나 저 적분이다. 반구 Ω 전체에서 들어오는 빛 L<sub>i</sub>는 또 다른 표면의 L<sub>o</sub>라서 방정식이 재귀적이고, 닫힌 형태의 해는 없다. 그래서 패스 트레이싱은 적분을 "계산"하지 않고 <strong>추정</strong>한다 — 이것이 <strong>몬테카를로 방법</strong>이다. 발상은 여론조사와 같다. 전 국민에게 다 물어보지 않아도 1,000명만 무작위로 뽑으면 평균은 전체를 대표한다. 적분도 마찬가지다 — 반구의 무한히 많은 방향을 전부 더하는 대신, <strong>방향 몇 개만 무작위로 뽑아 평균을 내고, 거기에 적분 구간의 크기를 곱하면 된다.</strong>
</p>

<div class="eq-anno-wrap">
<div class="formula-label">1단계 — 균일하게 뽑는 경우:</div>
<div class="eq-anno">
<span class="term">
<span class="t-formula"><span style="font-size:1.4em;">∫</span><sub>Ω</sub> <i>f</i>(<i>ω</i>) d<i>ω</i></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5 Q 27 2.5, 53 5.5 T 97 4" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">구하려는 적분<br>= 곡선 아래 넓이</span>
</span>
<span class="op">≈</span>
<span class="term">
<span class="t-formula">|Ω|</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M5 4 Q 32 6.5, 58 3.5 T 95 5" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">적분 구간의 크기<br>(반구면 입체각 2π)</span>
</span>
<span class="op">·</span>
<span class="term">
<span class="t-formula"><span class="frac"><span class="fr-t">1</span><span class="fr-b"><i>N</i></span></span><span style="font-size:1.35em;padding-left:5px;">Σ</span><sub><i>k</i></sub> <i>f</i>(<i>ω</i><sub>k</sub>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4.5 Q 25 7, 50 4 T 97 5.5" fill="none" stroke="#0a8f72" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#0a8f72;">무작위 N개 방향에서 잰 값의<br>평균 = 곡선의 "평균 높이"</span>
</span>
</div>
<div class="formula-note">넓이 = 밑변 × 평균 높이. 직사각형으로 곡선 아래 넓이를 근사하는 것과 같고, N이 늘수록 평균 높이가 참값에 수렴한다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
그런데 꼭 <strong>균일하게</strong> 뽑을 필요는 없다. 밝은 창문처럼 기여가 큰 방향을 더 자주 뽑을 수 있다면 그쪽이 낫다. 다만 공짜는 아니다 — 자주 뽑히는 방향은 평균에 그만큼 <strong>과대 대표</strong>되므로, 각 표본을 "그 방향이 뽑힐 확률밀도 p(ω<sub>k</sub>)"로 나눠서 공평하게 만들어야 한다. 이 1/p 보정이 정말 참값을 주는지는 기대값을 계산해 보면 한 줄로 확인된다.
</p>

<div class="eq-anno-wrap">
<div class="formula-label">2단계 — p로 뽑고 p로 나누면, 기대값에서 p가 약분된다:</div>
<div class="eq-anno">
<span class="term">
<span class="t-formula">𝔼<span style="font-size:1.15em;">[</span><span class="frac"><span class="fr-t"><i>f</i>(<i>ω</i><sub>k</sub>)</span><span class="fr-b"><i>p</i>(<i>ω</i><sub>k</sub>)</span></span><span style="font-size:1.15em;">]</span></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 26 2, 52 5 T 97 4" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">보정된 표본의 기대값<br>(ω<sub>k</sub>는 p에서 뽑힌다)</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><span style="font-size:1.4em;">∫</span><sub>Ω</sub> <span class="frac"><span class="fr-t"><i>f</i>(<i>ω</i>)</span><span class="fr-b"><i>p</i>(<i>ω</i>)</span></span> <i>p</i>(<i>ω</i>) d<i>ω</i></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4 Q 30 6.5, 55 3.5 T 97 5" fill="none" stroke="#6d28d9" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#6d28d9;">기대값 = 뽑힐 확률 p로 가중한 평균<br>→ 나눈 p와 곱한 p가 약분!</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><span style="font-size:1.4em;">∫</span><sub>Ω</sub> <i>f</i>(<i>ω</i>) d<i>ω</i></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5 Q 28 2.5, 54 5.5 T 97 3.5" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">원래 구하려던 적분 그대로<br>= "편향 없음"의 증명</span>
</span>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
1단계의 균일 추출은 p = 1/2π인 특수 경우일 뿐이다 — 1/p = 2π = |Ω|가 되어 "구간 크기 곱하기"로 돌아간다. 그리고 p를 f가 큰 방향에 몰아줄수록 표본 사이의 편차가 줄어 같은 N으로도 노이즈가 준다. 이것이 <strong>중요도 샘플링(importance sampling)</strong>이고, 뒤에 나올 코사인 가중 샘플링(02장)과 ray guiding(04장)은 전부 "p를 얼마나 영리하게 고르느냐"의 이야기다. 이제 두 단계를 합친 일반형이 아래의 몬테카를로 추정 공식이다.
</p>

<div class="eq-anno-wrap">
<div class="eq-anno">
<span class="term">
<span class="t-formula"><span style="font-size:1.4em;">∫</span><sub>Ω</sub> <i>f</i>(<i>ω</i>) d<i>ω</i></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5 Q 27 2.5, 53 5.5 T 97 4" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">구하려는 적분<br>(참값 I)</span>
</span>
<span class="op">≈</span>
<span class="term">
<span class="t-formula"><span class="frac"><span class="fr-t">1</span><span class="fr-b"><i>N</i></span></span><span style="font-size:1.35em;padding-left:5px;">Σ</span><sub><i>k</i></sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4 Q 30 6.5, 55 3.5 T 97 5" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">N개 뽑아서<br>평균 낸다</span>
</span>
<span class="term">
<span class="t-formula"><span class="frac"><span class="fr-t"><i>f</i>(<i>ω</i><sub>k</sub>)</span><span class="fr-b"><i>p</i>(<i>ω</i><sub>k</sub>)</span></span></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4.5 Q 25 7, 50 4 T 97 5.5" fill="none" stroke="#0a8f72" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#0a8f72;">그 방향에서 잰 값을<br>뽑힐 확률로 나눠 보정</span>
</span>
<span class="op">,</span>
<span class="term">
<span class="t-formula"><i>ω</i><sub>k</sub> ∼ <i>p</i>(<i>ω</i>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 27 3, 53 6 T 97 4" fill="none" stroke="#3d63e0" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#3d63e0;">방향은 확률밀도<br>p에서 추출</span>
</span>
</div>
<div class="formula-note">편향 없는 추정량: \(\mathbb E[\widehat I_N]=I\), 표준 오차는 \(O(N^{-1/2})\)</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
핵심 성질 두 가지. 첫째, 이 추정에는 <strong>편향이 없다(unbiased)</strong>. 방향 ω<sub>k</sub>를 무작위로 뽑기 때문에 <strong>추정값 Î<sub>N</sub>은 계산할 때마다 조금씩 다른 숫자가 나온다</strong> — 운 좋게 밝은 방향이 많이 뽑힌 판에서는 참값보다 크게, 어두운 방향만 뽑힌 판에서는 작게. 하지만 어느 쪽으로 치우치는 일 없이 그 기대값은 정확히 참값이다. 라이트맵 베이크에서는 텍셀마다 각자 다른 무작위 방향을 뽑으니 이웃 텍셀끼리 추정값이 들쭉날쭉해지는데, 이 들쭉날쭉함이 바로 패스 트레이싱 특유의 <strong>노이즈</strong>다. 즉 오차의 정체는 "계산이 틀려서 생긴 왜곡"이 아니라 "복권 추첨의 운"이고, 그래서 샘플 수 N을 4배로 늘리면 노이즈는 절반으로 준다(표준 오차 ∝ 1/√N). 둘째, 재귀는 경로로 풀린다 — 방향을 하나 뽑아 광선을 쏘고, 부딪힌 곳에서 또 하나 뽑아 쏘고… 를 반복하면 가지 치는 트리 대신 <strong>경로(path)</strong> 하나가 적분의 표본 하나가 된다. 카지야가 논문에서 "branching tree 대신 확률적으로 광선 하나만 쏘라"고 쓴 그대로다.
</p>

<p style="color:var(--text2);line-height:1.85;">
위의 몬테카를로 공식은 일반형이라, f(ω) 자리에 무엇을 넣을지는 문제마다 정하면 된다. 렌더링 방정식을 풀 때 f(ω)에 들어가는 것은 <strong>피적분 함수 전체</strong>, 즉 f(ω<sub>k</sub>) = f<sub>r</sub>(x, ω<sub>k</sub>, ω<sub>o</sub>) · L<sub>i</sub>(x, ω<sub>k</sub>) · cosθ<sub>k</sub>다. 그런데 여기서 라이트맵 베이크만의 제약이 등장한다. <strong>베이크 시점에는 카메라가 없다.</strong> f<sub>r</sub>은 나가는 방향 ω<sub>o</sub>를 인자로 받는 함수인데 ω<sub>o</sub>를 모르니, 뷰에 따라 값이 달라지는 스페큘러 BRDF는 평가할 방법이 없고 뷰와 무관한 재질만 가정할 수 있다. 램버시안(디퓨즈) BRDF는 f<sub>r</sub> = ρ/π로 ω<sub>i</sub>·ω<sub>o</sub> 어느 쪽과도 무관한 <strong>상수</strong>라서 적분 밖으로 빠지고, 그러면 몬테카를로가 추정해야 할 f(ω<sub>k</sub>)에는 <strong>L<sub>i</sub> · cosθ만 남는다</strong>. 아래 공식이 그 결과다 — L<sub>o</sub><sup>diff</sup>는 몬테카를로 공식에 대입하는 입력이 아니라, 추정으로 얻은 적분값 E(x)에 상수 ρ/π를 도로 곱해 나오는 <strong>최종 출력</strong>이다.
</p>

<div class="eq-anno-wrap">
<div class="formula-label">램버시안 가정:</div>
<div class="eq-anno">
<span class="term">
<span class="t-formula"><i>L</i><sub>o</sub><sup>diff</sup>(<i>x</i>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 26 2, 52 5 T 97 4" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">디퓨즈 표면이<br>내보내는 빛</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><span class="frac"><span class="fr-t"><i>ρ</i></span><span class="fr-b">π</span></span></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M6 4 Q 35 6.5, 60 3.5 T 94 5" fill="none" stroke="#0a8f72" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#0a8f72;">램버시안 BRDF — 방향과<br>무관한 상수 (적분 밖으로!)</span>
</span>
<span class="op">·</span>
<span class="term">
<span class="t-formula"><i>E</i>(<i>x</i>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M4 5 Q 28 2.5, 54 5.5 T 96 3.5" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">조도(irradiance) = ∫ <i>L</i><sub>i</sub> cosθ dω, 반구에서 받은 빛 총량<br>← 몬테카를로가 실제로 추정하는 부분</span>
</span>
</div>
<div class="formula-label formula-label-next">GPU Lightmass가 텍셀에 저장하는 값:</div>
<div class="eq-anno">
<span class="term">
<span class="t-formula">Lightmap(<i>x</i>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4.5 Q 25 7, 50 4 T 97 5.5" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">텍셀에 남는 숫자</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><span class="frac"><span class="fr-t"><i>E</i>(<i>x</i>)</span><span class="fr-b">π</span></span></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M5 4 Q 32 6, 58 3.5 T 95 5" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">조도 ÷ π</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><span class="frac"><span class="fr-t">1</span><span class="fr-b">π</span></span><span style="font-size:1.4em;padding-left:4px;">∫</span><sub>Ω⁺(<b>n</b>)</sub> <i>L</i><sub>i</sub>(<i>x</i>, <i>ω</i><sub>i</sub>)(<b>n</b> · <i>ω</i><sub>i</sub>) d<i>ω</i><sub>i</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M2 5 Q 25 2.5, 50 5.5 T 98 4" fill="none" stroke="#6d28d9" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#6d28d9;">들어온 빛만 모은다<br>— ρ는 어디에도 없다!</span>
</span>
</div>
<div class="formula-note">알베도 \(\rho\)는 저장하지 않고 런타임에 곱한다: \(L_o^{\mathrm{diff}}(x)=\rho\,\operatorname{Lightmap}(x)\).</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
즉 GPU Lightmass가 만드는 값은 <strong>조도(irradiance) E(x)를 π로 나눈 것</strong> — 다르게 말하면 "알베도가 1인 하얀 램버시안 표면이었을 때 그 점이 내보낼 radiance"다. 왜 하필 π로 나누는지는 에너지 보존으로 설명된다. 램버시안 표면은 받은 빛을 모든 방향으로 <strong>균일한 radiance L<sub>o</sub></strong>로 되쏘는데, 나가는 에너지를 반구 전체에서 합치면 L<sub>o</sub> · ∫cosθ dω = <strong>π · L<sub>o</sub></strong>가 된다 — 반구 코사인 적분값이 정확히 π이기 때문이다. 알베도 1이면 이 나가는 총량이 받은 총량 E와 같아야 하므로 L<sub>o</sub> = E/π. 즉 π는 어떤 물리 법칙이 아니라 <strong>"반구 전체"라는 기하학이 만들어내는 상수</strong>이고, 램버시안 BRDF에 붙어 있던 1/π(f<sub>r</sub> = ρ/π)의 정체도 이것이다 — π로 나눠줘야 되쏘는 에너지가 받은 에너지를 넘지 않는다. 재질의 알베도 ρ는 <strong>일부러 빼고</strong> 굽는다. 알베도는 런타임에 G버퍼에서 읽어 곱하면 되고, 그래야 라이트맵 해상도(보통 텍셀 하나가 수~수십 cm)가 아닌 <strong>재질 텍스처 해상도로 알베도 디테일이 살아나며</strong>, 베이크 후에 머티리얼의 베이스컬러를 바꿔도 라이팅이 (근사적으로) 유효하다. 이 분리는 06장에서 코드로 다시 확인한다.
</p>

<div class="callout callout-purple">
<div class="callout-title">한 줄 요약</div>
<p>GPU Lightmass의 공식은 <strong>"렌더링 방정식의 산란 적분항을, 디퓨즈 BRDF 가정 하에, 텍셀당 몬테카를로 패스 트레이싱으로 추정한 것"</strong>이다. 텍셀에 남는 숫자는 조도/π이고, 방향 정보는 SH 계수로 함께 저장된다(05장).</p>
</div>

<span class="section-eyebrow">02 — 커널</span>
</div>

# 텍셀이 카메라가 된다 — PathTracingKernel 해부

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
베이커에서 가장 중요한 코드는 <code>Engine/Plugins/Experimental/GPULightmass/Shaders/Private/LightmapPathTracing.usf</code>의 <code>PathTracingKernel()</code>과 이를 호출하는 레이젠 셰이더 <code>LightmapPathTracingMainRG()</code>다. 파일 첫머리의 include 목록만 봐도 정체가 드러난다 — <code>PathTracingCommon.ush</code>, <code>PathTracingLightSampling.ush</code>, <code>PathTracingMaterialSampling.ush</code> 등 <strong>엔진 레퍼런스 패스 트레이서의 라이브러리를 그대로 공유</strong>한다. 무비 렌더 큐에서 쓰는 그 패스 트레이서와 재질 평가·광원 샘플링 코드가 같은 뿌리다.
</p>

<p style="color:var(--text2);line-height:1.85;">
일반 패스 트레이서는 카메라에서 픽셀을 향해 1차 광선을 쏜다. 라이트맵 베이커에는 카메라가 없으므로, GPULM은 트릭을 쓴다 — <strong>1차 광선을 실제로 쏘지 않고, 히트 페이로드를 라이트맵 텍셀 위치에 직접 심는다.</strong> 그리고 그 텍셀을 albedo=1인 완전 디퓨즈 표면으로 취급한다.
</p>

<div class="code-block"><span class="code-lang">LightmapPathTracing.usf — bounce 0 (텍셀 심기)</span><span class="cm">// 1차 광선은 가짜: 텍셀 월드 위치·노멀을 페이로드에 직접 기록</span>
Payload.TranslatedWorldPos = TranslatedWorldPosition;
Payload.WorldNormal        = WorldNormal;
<span class="kw">...</span>
Payload.BaseColor = <span class="num">1</span>;                              <span class="cm">// albedo = 1 (하얀 표면)</span>
Payload.ShadingModelID = PATH_TRACING_SHADINGMODELID_BASIC;  <span class="cm">// 순수 램버시안</span></div>

<p style="color:var(--text2);line-height:1.85;">
이렇게 하면 bounce 0의 재질 샘플링이 자동으로 <strong>텍셀 반구의 코사인 가중 샘플링</strong>이 된다. 이후는 여느 패스 트레이서와 똑같이 경로가 이어진다. 경로가 끝나고 돌아온 radiance는 텍셀별 누적 버퍼에 원자적으로 더해진다.
</p>

<div class="code-block"><span class="code-lang">LightmapPathTracing.usf — 샘플 누적</span><span class="cm">// RadianceValue: 이 경로가 모아온 빛, TangentZ: cosθ</span>
IrradianceAndSampleCount.rgb += RadianceValue * TangentZ / PI;   <span class="cm">// ← 조도/π 누적</span>
IrradianceAndSampleCount.w   += <span class="num">1</span>;                               <span class="cm">// 샘플 카운트</span>
SHDirectionality             += SH.L2SHCoefficients;             <span class="cm">// 방향성 SH (05장)</span></div>

<p style="color:var(--text2);line-height:1.85;">
누적된 값은 패스가 끝날 때마다가 아니라 최종 출력 단계(<code>LightmapOutput.usf</code>의 <code>SelectiveLightmapOutputCS</code>)에서 <code>OutputColor = IrradianceAndSampleCount.rgb / SampleCount</code>로 나눠져 표본 평균이 된다 — 01장의 (1/N)Σ가 코드로 옮겨진 지점이다. 얼마나 쌓나? <code>GPULightmassSettings.h</code>의 <strong><code>GISamples</code> 기본값 512</strong>가 "텍셀당, 모든 바운스에 걸쳐 실행되는 광선 경로의 총 개수"다. 렌더 패스 1회가 텍셀당 경로 1개씩을 진행시키고, 512 패스가 쌓이면 그 텍셀은 수렴한 것으로 표시된다(<code>LightmapRenderer.cpp</code>). 남은 노이즈는 마지막에 디노이저(기본 Intel Open Image Denoise)가 정리한다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 640 250" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs>
<marker id="gp-ah1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#b45309"/></marker>
<marker id="gp-ah2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#6d28d9"/></marker>
</defs>
<line x1="40" y1="200" x2="360" y2="200" stroke="#4a4038" stroke-width="2"/>
<path d="M 120 200 A 90 90 0 0 1 300 200" fill="rgba(180,83,9,0.05)" stroke="rgba(180,83,9,0.4)" stroke-width="1" stroke-dasharray="4 4"/>
<circle cx="210" cy="200" r="5" fill="#b45309"/>
<text x="210" y="222" fill="#8a7f74" font-size="11" text-anchor="middle">라이트맵 텍셀 x (albedo=1 램버시안으로 취급)</text>
<line x1="210" y1="200" x2="150" y2="130" stroke="#b45309" stroke-width="1.4" marker-end="url(#gp-ah1)"/>
<line x1="210" y1="200" x2="230" y2="118" stroke="#b45309" stroke-width="1.4" marker-end="url(#gp-ah1)"/>
<line x1="210" y1="200" x2="285" y2="150" stroke="#b45309" stroke-width="1.4" marker-end="url(#gp-ah1)"/>
<text x="210" y="100" fill="#b45309" font-size="11" text-anchor="middle">cosine 가중 방향 샘플 → 경로 시작</text>
<rect x="420" y="60" width="180" height="130" rx="10" fill="rgba(109,40,217,0.05)" stroke="rgba(109,40,217,0.35)" stroke-width="1.2"/>
<text x="510" y="86" fill="#6d28d9" font-size="12" text-anchor="middle" font-weight="600">텍셀 누적 버퍼</text>
<text x="510" y="112" fill="#4a4038" font-size="11" text-anchor="middle">Σ Radiance·cosθ/π</text>
<text x="510" y="132" fill="#4a4038" font-size="11" text-anchor="middle">Σ SH 방향성 계수</text>
<text x="510" y="152" fill="#4a4038" font-size="11" text-anchor="middle">SampleCount N</text>
<text x="510" y="176" fill="#8a7f74" font-size="10" text-anchor="middle">마지막에 ÷N → 라이트맵</text>
<line x1="315" y1="160" x2="415" y2="130" stroke="#6d28d9" stroke-width="1.4" marker-end="url(#gp-ah2)"/>
<text x="360" y="132" fill="#6d28d9" font-size="10" text-anchor="middle">경로당 1샘플 × 512</text>
</svg>
<div class="scene-cap">텍셀이 카메라를 대신한다 — 텍셀 반구에서 경로를 512개 출발시켜, 각 경로가 가져온 radiance·cosθ/π를 평균 내면 그 텍셀의 라이트맵 값(조도/π)이 된다.</div>
</div>

<span class="section-eyebrow">03 — 경로의 삶</span>
</div>

# 경로 하나는 어떻게 살고 죽나 — NEE·MIS·러시안 룰렛

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
커널의 메인 루프는 <code>for (int Bounce = 0; Bounce &lt;= MaxBounces; Bounce++)</code>이고 <code>MaxBounces = 32</code>로 하드코딩되어 있다. 하지만 실제로 32번 튕기는 경로는 거의 없다 — 종료는 <strong>러시안 룰렛</strong>이 확률적으로 결정한다.
</p>

<div class="code-block"><span class="code-lang">LightmapPathTracing.usf — 러시안 룰렛</span><span class="cm">// 다음 바운스 기여의 상한/현재 처리량 비율로 "계속 확률"을 정한다</span>
<span class="kw">float</span> ContinuationProb = sqrt(saturate(max3(NextPathThroughput) / max3(PathThroughput)));
<span class="kw">if</span> (RussianRouletteRand &gt;= ContinuationProb)
    <span class="kw">break</span>;                                  <span class="cm">// 경로 사망</span>
PathThroughput = NextPathThroughput / ContinuationProb;  <span class="cm">// 생존 시 1/확률 보정 → 기대값이 안 변한다 (unbiased)</span></div>

<p style="color:var(--text2);line-height:1.85;">
살아남은 경로의 처리량을 생존 확률로 나눠주는 마지막 줄이 핵심이다. 이 보정 덕분에 경로를 일찍 끊어도 <strong>추정의 기대값은 변하지 않는다</strong> — PBRT 교과서에 나오는 표준 기법 그대로다. 어두워진 경로(처리량이 작아진 경로)일수록 빨리 죽고, 밝은 경로는 오래 산다. 계산량은 아끼면서 편향은 만들지 않는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
분산을 줄이는 두 축은 프로덕션 패스 트레이서의 정석 조합이다. 첫째, <strong>NEE(next event estimation, 명시적 광원 샘플링)</strong> — 매 바운스에서 광원을 직접 하나 골라 그림자 광선을 쏜다. 광원 선택은 공간을 분할한 <strong>light grid</strong>(<code>LightGridLookup</code> → <code>EstimateLight</code> → <code>SelectLight</code> → <code>SampleLight</code>)로 가속된다. 둘째, <strong>MIS(multiple importance sampling)</strong> — 같은 빛을 광원 샘플링으로도, BRDF 샘플링으로도 셀 수 있으므로 <code>MISWeightPower(LightSample.Pdf, MaterialEval.Pdf)</code> 파워 휴리스틱으로 이중 계산 없이 두 전략의 장점을 합친다(<code>MISMode = 2</code>, Material과 Light 둘 다). 그 밖에 emissive 재질의 기여(<code>EnableEmissive = 1</code> — 방정식의 L<sub>e</sub> 항이 간접광 경로에 실려 들어온다), 반투명을 통과하며 색이 물드는 그림자 광선(<code>TraceTransparentVisibilityRay</code>), 러프니스를 경로를 따라 단조 증가시켜 코스틱 노이즈를 죽이는 approximate caustics까지 갖췄다.
</p>

<div class="callout callout-warn">
<div class="callout-title">직접광과 간접광은 같은 루프에서 갈라진다</div>
<p>커널은 bounce 0에서 광원을 맞힌 기여(=직접광)와 bounce 1 이상의 기여(=간접광)를 <strong>다른 버퍼에 나눠 담는다</strong>. 그리고 직접광은 <code>if (!IsStationary(LightId))</code> 조건으로 <strong>Static 라이트일 때만</strong> 라이트맵에 들어간다. Stationary 라이트의 직접광은 런타임에 동적으로 계산해야 하므로(그래야 라이트 색·세기를 게임 중에 바꿀 수 있다), 라이트맵에는 넣지 않고 별도의 <strong>섀도마스크</strong>(05장)로 가시성만 굽는다. 결과적으로 컬러 라이트맵 = <strong>간접광(모든 라이트) + 직접광(Static 전용)</strong>이다.</p>
</div>

<span class="section-eyebrow">04 — 분산 저감</span>
</div>

# 편향과 맞바꾼 속도 — Irradiance Caching과 Ray Guiding

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
순수 패스 트레이싱만으로도 답은 나오지만, 수렴이 느리다. GPULM은 두 개의 가속 장치를 얹는다. 첫째는 <strong>Irradiance Caching</strong>(기본 켜짐, <code>IrradianceCachingCommon.ush</code>). 첫 바운스가 도착한 지점의 간접 조도를 공간 해시 테이블(<code>ICHashTableFind</code>, 원자적 누적)에 기록해두고, 이후 경로가 근처에 다시 도착하면 <strong>경로를 이어가는 대신 캐시 값을 읽고 조기 종료</strong>한다. 모서리 근처 거부, 최대 조회 거리 제한, 뒷면 감지 같은 누출 방지 장치가 붙어 있다. Epic 문서 스스로 이 옵션을 "더 물리적으로 올바른 GI 강도를 주지만 <strong>약간의 편향(some biasing)</strong>이 생긴다"고 적어둔다 — 편향 없는 추정기에 일부러 작은 편향을 넣는 대신 수렴 속도를 얻는, 오프라인 렌더링의 고전적인 트레이드오프다.
</p>

<p style="color:var(--text2);line-height:1.85;">
둘째는 <strong>First Bounce Ray Guiding</strong>(옵션). 본 베이크 전 시험 패스에서 텍셀 클러스터별로 "어느 방향이 밝은가"를 방향 빈에 기록하고(<code>InterlockedMax(RayGuidingLuminance[...])</code>), 그로부터 2D CDF를 만들어(<code>FirstBounceRayGuidingCDFBuild.usf</code>) 첫 바운스 방향 샘플링을 밝은 쪽 — 예컨대 실내 씬의 창문 — 으로 몰아준다. 코사인 가중만으로는 창문처럼 좁고 밝은 입사 방향을 잘 못 맞히는 문제를 중요도 샘플링으로 푸는 것이다.
</p>

<span class="section-eyebrow">05 — 저장</span>
</div>

# 무엇이 어떻게 구워지나 — 조도 + SH 방향성, 그리고 섀도마스크

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
텍셀에 조도/π 스칼라(RGB)만 저장하면 문제가 하나 생긴다 — <strong>노멀맵이 죽는다.</strong> 라이트맵 UV의 버텍스 노멀 기준으로 구운 값 하나뿐이면, 픽셀 단위로 흔들리는 노멀맵이 간접광에 아무 영향을 못 준다. 그래서 GPULM은 색과 함께 <strong>빛이 주로 어느 방향에서 왔는지</strong>를 구면 조화 함수(SH) 계수로 굽는다. 베이크 중 매 샘플이 <code>FL2SHAndCorrection::AddIncomingRadiance</code>(<code>LightmapEncoding.ush</code>)로 휘도 × SH 기저를 누적하고, 마지막에 디퓨즈 컨볼루션과 정규화를 거쳐 <strong>L1(선형) 방향 벡터</strong>로 압축된다. 런타임에는 이 벡터와 픽셀 노멀의 내적이 밝기를 변조한다(06장).
</p>

<div class="data-table">
<table>
<tr><th>산출물</th><th>내용</th><th>인코딩 (LightmapEncoding.cpp)</th></tr>
<tr><td><strong>HQ 라이트맵</strong> (텍스처 2장)</td><td>조도/π 색 + 휘도 방향성</td><td>Coeff0: <strong>LogLUVW</strong> — 크로마 U,V,W + LogL = Log2(L + BlackPoint), LogScale 11.5 (HDR을 8비트에)<br>Coeff1: L1 SH 방향 벡터 Dx,Dy,Dz + LogL 정밀도 보강용 Residual</td></tr>
<tr><td><strong>LQ 라이트맵</strong> (모바일)</td><td>동일 정보의 저가형</td><td>Coeff2: LogRGB (SimpleLogScale 16), Coeff3: SH 방향 벡터</td></tr>
<tr><td><strong>섀도마스크</strong></td><td>Stationary 라이트별 가시성</td><td>텍셀당 광선 128개(<code>StationaryLightShadowSamples</code>)로 가시성을 추적하는 전용 레이젠 셰이더(<code>StationaryLightShadowTracingMainRG</code>) → <strong>signed distance field</strong> 그림자 샘플로 변환. 채널당 라이트 1개, 최대 4개</td></tr>
<tr><td><strong>Sky Bent Normal</strong></td><td>하늘이 보이는 평균 방향 + 가림 정도</td><td>그림자 드리우는 Stationary 스카이라이트용. xyz = 굽은 노멀, w = sqrt(길이)</td></tr>
<tr><td><strong>AO 머티리얼 마스크</strong></td><td>베이크된 AO</td><td>sqrt 인코딩 1채널</td></tr>
<tr><td><strong>볼류메트릭 라이트맵</strong></td><td>움직이는 오브젝트용 프로브 (07장)</td><td>희소 브릭 + 3밴드 SH</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
색이 <strong>로그 인코딩</strong>인 이유는 간단하다 — 조도는 HDR인데 라이트맵은 8비트 텍스처(+블록 압축)라서, 선형으로 담으면 어두운 영역이 계단진다. LogLUVW는 휘도만 로그 공간에 넣고 색도는 따로 담아, 넓은 다이내믹 레인지를 싸게 보존한다.
</p>

<span class="section-eyebrow">06 — 런타임</span>
</div>

# 렌더링 방정식의 어느 항에 더해지나 — 베이스 패스의 디퓨즈, 오직 디퓨즈

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
이제 서두에서 던진 질문의 후반부 차례다 — <strong>구운 값은 최종 라이팅의 어디에 더해지는가?</strong> 답은 베이스 패스에 있다. <code>BasePassPixelShader.usf</code>의 <code>GetPrecomputedIndirectLightingAndSkyLight()</code>가 <code>LightmapCommon.ush</code>의 디코더를 호출한다.
</p>

<div class="code-block"><span class="code-lang">LightmapCommon.ush — GetLightMapColorHQ (요지)</span><span class="cm">// 텍스처 2장에서 LogL과 SH 방향 벡터를 복원한 뒤:</span>
<span class="kw">float</span> Directionality = max(<span class="num">0.0</span>, dot(SH, <span class="kw">float4</span>(WorldNormal.yzx, <span class="num">1</span>)));  <span class="cm">// 픽셀 노멀 × 구운 방향</span>
<span class="kw">float</span> Luma  = exp2(LogL * LogScale) - LogBlackPoint;
<span class="kw">float3</span> Color = Luma * Directionality * UVW;      <span class="cm">// ← OutDiffuseLighting</span></div>

<p style="color:var(--text2);line-height:1.85;">
05장에서 구운 SH가 쓰이는 지점이 바로 여기다 — <strong>노멀맵이 적용된 픽셀 단위 월드 노멀</strong>과 구운 방향 벡터의 내적이 밝기를 조절하므로, 라이트맵 해상도보다 훨씬 고운 노멀 디테일이 간접광에 살아난다(방향성을 끄면 상수 0.6으로 대체된다). 이렇게 나온 <code>DiffuseIndirectLighting</code>은 최종적으로 이렇게 합쳐진다.
</p>

<div class="code-block"><span class="code-lang">BasePassPixelShader.usf (요지)</span>GBuffer.DiffuseColor = BaseColor - BaseColor * Metallic;     <span class="cm">// 알베도 ρ</span>
<span class="kw">...</span>
DiffuseColor += (DiffuseIndirectLighting * DiffuseColorForIndirect   <span class="cm">// ← 라이트맵 × ρ</span>
               + SubsurfaceIndirectLighting * SubsurfaceColor)
               * AOMultiBounce(GBuffer.BaseColor, DiffOcclusion);</div>

<p style="color:var(--text2);line-height:1.85;">
01장의 공식이 완성되는 순간이다 — 베이크가 남겨둔 ρ가 여기서 곱해져 <strong>ρ × (조도/π)</strong>, 즉 램버시안 항 (ρ/π)·E(x)가 된다. 방정식 관점으로 최종 픽셀을 분해하면 이렇다.
</p>

<div class="eq-anno-wrap">
<div class="formula-label">최종 픽셀:</div>
<div class="eq-anno">
<span class="term">
<span class="t-formula"><i>L</i><sub>pixel</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M4 5 Q 28 2.5, 54 5.5 T 96 4" fill="none" stroke="#4a4038" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#4a4038;">화면 픽셀의<br>최종 빛</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><i>L</i><sub>direct</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4 Q 30 6.5, 55 3.5 T 97 5" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">직접광 — 런타임에 계산<br>(Stationary·Movable, 섀도마스크로 감쇠)</span>
</span>
<span class="op">+</span>
<span class="term">
<span class="t-formula"><i>ρ</i> · Lightmap(<i>x</i>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 26 2, 52 5 T 97 4" fill="none" stroke="#b45309" stroke-width="2.4" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">★ GPU Lightmass의 자리<br>디퓨즈 간접광 + Static 직접광</span>
</span>
<span class="op">+</span>
<span class="term">
<span class="t-formula"><i>L</i><sub>indirect</sub><sup>spec</sup></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4.5 Q 25 7, 50 4 T 97 5.5" fill="none" stroke="#6d28d9" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#6d28d9;">스페큘러 간접광 — 라이트맵과 무관<br>(Reflection Capture·Lumen·SSR)</span>
</span>
<span class="op">+</span>
<span class="term">
<span class="t-formula"><i>L</i><sub>e</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M4 4 Q 30 6, 56 3.5 T 96 5" fill="none" stroke="#d6304a" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#d6304a;">자발광 (그 간접 기여는<br>라이트맵에 이미 포함)</span>
</span>
</div>
</div>

<div class="callout callout-info">
<div class="callout-title">스페큘러에는 라이트맵이 한 방울도 안 들어간다</div>
<p>라이트맵 값은 <code>DiffuseColor</code>에만 곱해지고 <code>SpecularColor</code> 경로에는 등장하지 않는다. 뷰 의존 항은 베이크 시점에 계산 자체가 불가능하기 때문이다(ω<sub>o</sub>를 모른다). 정적 라이팅 씬에서 금속·유리가 리플렉션 캡처나 Lumen 리플렉션을 따로 필요로 하는 이유가 이것이다. 참고로 경로의 <strong>중간</strong> 바운스에서는 글로시 재질도 온전히 평가된다(<code>PathTracingGlossy.ush</code>) — 스페큘러 표면을 <em>거쳐 온</em> 빛은 라이트맵에 담기지만, 텍셀에서 <em>나가는</em> 스페큘러는 담기지 않는다.</p>
</div>

<span class="section-eyebrow">07 — 볼류메트릭 라이트맵</span>
</div>

# 움직이는 오브젝트를 위한 베이크 — 공간에 뿌린 SH 프로브

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
라이트맵은 정적 지오메트리의 UV에 붙는다. 그럼 그 씬을 걸어다니는 캐릭터는? GPULM은 공간 자체에도 같은 패스 트레이싱을 돌린다 — <strong>볼류메트릭 라이트맵</strong>이다. 씬을 4×4×4 셀 단위의 <strong>희소 브릭 계층</strong>으로 복셀화하고(지오메트리 근처일수록 조밀), 각 복셀에서 동일한 <code>PathTracingKernel</code>을 위/아래 두 반구로 실행해 전방향 입사 radiance를 모은다. 저장은 표면 라이트맵보다 한 등급 높은 <strong>3밴드(L2) SH</strong> — AmbientVector(DC항) + RGB별 고차 계수 — 에 sky bent normal, 그리고 Stationary 디렉셔널 라이트를 향한 가림 샘플 32개로 만든 <code>DirectionalLightShadowing</code>까지 얹는다. 런타임에는 <code>GetPrecomputedIndirectLightingAndSkyLight</code>의 볼륨 경로가 브릭 텍스처에서 SH를 보간해 <code>DotSH3(IrradianceSH, CalcDiffuseTransferSH3(Normal)) / PI</code>로 평가한다 — 역시 <strong>디퓨즈 항</strong>이다. 06장과 똑같은 자리에, 텍셀 대신 프로브 보간으로 공급될 뿐이다.
</p>

<div class="scene-fig">
<img src="/assets/img/post/gpu-lightmass/volumetric-lightmap-sh-sketch-white.webp" width="1254" height="1254" style="display:block;width:100%;height:auto;" alt="흰 배경의 연필 스케치로 그린 지오메트리 주변 적응형 프로브와 SH 기반 볼류메트릭 라이트맵">
<div class="scene-cap">볼류메트릭 라이트맵은 지오메트리 근처에 프로브를 더 조밀하게 배치하고, 각 지점에서 구운 전방향 입사광을 L2 SH 계수로 저장한다.</div>
</div>

<span class="section-eyebrow">08 — Lumen과의 차이</span>
</div>

# 같은 방정식, 다른 절단 — Lumen은 무엇을 근사하나

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
Lumen도 결국 같은 적분 ∫ f<sub>r</sub>·L<sub>i</sub>·cosθ dω를 푼다. 다른 것은 <strong>쓸 수 있는 시간</strong>이다 — GPULM은 텍셀 하나에 512개 경로를 수렴할 때까지 몇 분이든 쓸 수 있지만, Lumen은 프레임당 몇 ms 안에 화면 전체를 채워야 한다. 그래서 Lumen은 적분의 거의 모든 구성 요소를 캐시와 근사로 바꿨다. (Lumen 자체의 상세 해부는 <a href="/lumen">별도 글</a>에 있으니, 여기서는 GPULM과 대조되는 지점만 짚는다.)
</p>

<div class="data-table">
<table>
<tr><th>렌더링 방정식의 구성 요소</th><th>GPU Lightmass (오프라인)</th><th>Lumen (실시간)</th></tr>
<tr><td><strong>씬 지오메트리</strong> (광선이 부딪히는 대상)</td><td>실제 삼각형 BVH (DXR)</td><td>기본은 <strong>distance field(SDF)</strong> 콘 트레이싱 — 삼각형·UV·재질이 없는 근사 표면. HWRT 켜면 삼각형</td></tr>
<tr><td><strong>히트 지점의 L<sub>i</sub></strong> (부딪힌 곳의 빛)</td><td>그 지점에서 재질·광원을 <strong>매번 온전히 평가</strong>하고 경로를 이어감</td><td><strong>Surface Cache</strong>(메시당 최대 6방향 평면 투영 카드에 미리 계산해둔 라이팅)를 <strong>룩업</strong>. Hit Lighting 모드를 켜도 2차 바운스부터는 다시 캐시</td></tr>
<tr><td><strong>적분 (파이널 개더)</strong></td><td>텍셀당 512 경로, 수렴까지</td><td>16×16 픽셀당 스크린 프로브 1개 × 프로브당 8×8=64 광선 — 픽셀당 1광선 미만. 모자란 만큼은 시간 축에서 메운다: 최대 <strong>10프레임 누적</strong>(α=1/(1+N)) + 공간 필터</td></tr>
<tr><td><strong>바운스 횟수</strong></td><td>명시적: 최대 32 + 러시안 룰렛, 한 번의 적분 안에서 전부 해결</td><td>암묵적: Surface Cache가 자기 자신을 다시 비추는 <strong>프레임 간 피드백 루프</strong> — 프레임마다 바운스가 1씩 쌓여 "무한 바운스"에 점근 (radiosity 방식)</td></tr>
<tr><td><strong>캐시 갱신 속도</strong></td><td>해당 없음 (전 텍셀 수렴)</td><td>프레임당 Surface Cache 텍셀의 <strong>1/32(직접광)·1/64(간접광)</strong>만 갱신</td></tr>
<tr><td><strong>스페큘러 간접광</strong></td><td><strong>없음</strong> — 뷰를 모르니 원리적으로 불가</td><td><strong>있음</strong> — GGX 로브 중요도 샘플링 전용 리플렉션 트레이싱 + 디노이저</td></tr>
<tr><td><strong>동적 변화</strong></td><td>불가 — 라이트·지오메트리가 바뀌면 재베이크</td><td>가능 — 애초에 이것 때문에 만들어졌다. 단, 라이팅이 급변하면 몇 프레임의 지연·고스팅</td></tr>
<tr><td><strong>런타임 비용</strong></td><td>텍스처 샘플 몇 번 (사실상 0)</td><td>프레임 시간의 상당 부분</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
표의 두 번째 줄이 가장 본질적인 차이다. 패스 트레이서는 광선이 부딪힌 곳에서 "그 지점의 빛"을 <strong>그 자리에서 새로 계산</strong>한다. Lumen의 소프트웨어 트레이싱은 SDF에 부딪히는 순간 삼각형도 UV도 없으므로 계산할 재료 자체가 없다 — 대신 <strong>미리 라이팅해둔 Surface Cache를 샘플링</strong>한다(<code>LumenSoftwareRayTracing.ush</code>의 <code>EvaluateRayHitFromSurfaceCache</code>). 그래서 Lumen GI의 정확도 상한은 언제나 "Surface Cache가 씬을 얼마나 잘 대표하는가"다. 카드 6방향 평면 투영이 못 덮는 복잡한 실내 구조나 얇은 지오메트리에서 커버리지 구멍이 생기고, 이는 문서에도 명시된 한계다(반사 속 검은 영역 등).
</p>

<span class="section-eyebrow">09 — 물리성</span>
</div>

# 어느 쪽이 더 물리 기반인가 — bias의 Lumen, noise의 Lightmass

<div class="gplm-post">
<p style="color:var(--text2);line-height:1.85;">
"뭐가 더 물리 기반 렌더링인가"라는 질문에 정확히 답하려면 기준을 하나 정해야 한다 — <strong>렌더링 방정식에 대한 충실도</strong>. 이 기준에서 두 시스템의 오차는 종류가 다르다.
</p>

<div class="vs-grid">
<div class="vs-card bake">
<h4>GPU Lightmass — 오차는 노이즈</h4>
<p>몬테카를로 패스 트레이싱은 (러시안 룰렛 보정까지 포함해) 기대값이 참값과 일치하는, <strong>사실상 편향 없는(unbiased) 추정기</strong>다. 셰이더 스스로 "Reference path tracing"이라 자칭한다. 틀린 값이 아니라 흔들리는 값이고, 샘플을 늘리면 오차는 0으로 수렴한다.</p>
<p>편향이 끼어드는 지점은 손에 꼽는다: 기본으로 켜져 있는 Irradiance Caching(Epic 표현으로 "some biasing"), MaxBounces=32 상한, approximate caustics의 러프니스 클램프, 그리고 디노이저. 전부 "얼마나 빨리 수렴하나"의 문제지 "어디로 수렴하나"를 크게 바꾸지는 않는다.</p>
</div>
<div class="vs-card lumen">
<h4>Lumen — 오차는 체계적 편향</h4>
<p>distance field 지오메트리, 평면 카드 투영, 캐시 룩업, 1/16 해상도 프로브 보간, 10프레임 시간 누적 — 모두 샘플을 늘려도 사라지지 않는 <strong>구조적 근사</strong>다.</p>
<p>소스에는 안정성을 위한 비물리적 장치가 명시적으로 들어 있다: 다중 바운스 폭주를 막으려 알베도를 0.99로 클램프(<code>LumenDiffuseColorBoost.ush</code> — "don't allow it to reach 1 as multi-bounce would explode"), 파이어플라이를 죽이며 에너지를 잃는 ray intensity 클램프, 가림 부족을 가리려 <strong>일부러 스카이라이트를 새게 하는</strong> <code>GetSkylightLeaking</code>, 캐시 자기참조 피드백을 끊는 최소 트레이스 거리 등.</p>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
그러니 <strong>방정식 충실도를 기준으로 삼으면 답은 GPU Lightmass다.</strong> 같은 정적 씬을 놓고 비교하면 GPULM의 결과가 ground truth(경로 추적 참조 해)에 훨씬 가깝다 — 애초에 GPULM 자체가 그 참조 해를 구하는 계산기의 라이트맵 버전이니까. 하지만 이 답에는 방향이 정반대인 단서가 하나 붙는다 — <strong>GPULM은 방정식의 좁은 조각만 푼다.</strong> 정적 지오메트리, Static/Stationary 라이트, 디퓨즈 항. 씬이 움직이는 순간 그 "정확한 해"는 유효하지 않은 해가 되고, 뷰 의존 항은 아예 계산 대상이 아니다. Lumen은 부정확한 대신 방정식의 <strong>더 넓은 영역</strong> — 완전 동적 씬, 디퓨즈+글로시 스페큘러 — 을 매 프레임 다시 푼다. Epic이 Lumen을 만든 이유가 정확히 라이트맵의 이 제약("긴 빌드 시간, 게임 환경에 대한 큰 제약")이었다.
</p>

<div class="callout callout-purple">
<div class="callout-title">정확한 프레이밍</div>
<p>"물리 기반이냐"는 이분법보다 카지야의 원래 관점이 유용하다 — 그의 1986년 논문은 로컬 셰이딩·Whitted·라디오시티를 전부 <strong>하나의 방정식에 대한 서로 다른 근사</strong>로 자리매김했다. GPU Lightmass와 Lumen도 마찬가지다. 하나는 <strong>시간축을 포기하고 정확도를 취한 근사</strong>(오프라인, 수렴, 정적), 다른 하나는 <strong>정확도의 상당 부분을 내주고 시간축을 산 근사</strong>(실시간, 편향, 동적)다. 그래서 실무에서 "무엇이 더 물리적인가"는 "이 씬에서는 어느 쪽 오차를 감당할 만한가"로 바꿔 묻는 편이 낫다 — 라이팅이 고정된 건축 시각화·소규모 정적 레벨이라면 GPULM의 노이즈(시간을 들이면 사라진다)가, 동적 라이팅·대규모 월드라면 Lumen의 편향(아트 디렉션으로 덮을 수 있다)이 감당할 만한 쪽이다.</p>
</div>

<span class="section-eyebrow">10 — 정리</span>
</div>

# 정리

<div class="gplm-post">
<div class="summary-box">
<h3>GPU Lightmass 한 장 요약</h3>
<p><strong>공식:</strong> 렌더링 방정식 L<sub>o</sub> = L<sub>e</sub> + ∫ f<sub>r</sub>·L<sub>i</sub>·cosθ dω의 적분항을, 라이트맵 텍셀을 albedo=1 램버시안 표면 삼아 <strong>텍셀당 512개 몬테카를로 경로</strong>(DXR, NEE + MIS 파워 휴리스틱, 러시안 룰렛, 최대 32바운스)로 추정한다. 텍셀에 저장되는 값은 <strong>조도/π</strong>(알베도 제외)와 L1 SH 방향성 계수이며, LogLUVW로 HDR 인코딩된다.</p>
<p><strong>방정식에서의 자리:</strong> 베이스 패스에서 <code>DiffuseColor(ρ) × 라이트맵</code>으로 <strong>디퓨즈 항에만</strong> 더해진다 — 간접광은 전부, 직접광은 Static 라이트 것만. Stationary 직접광은 별도 섀도마스크로 가시성만 굽고 런타임에 계산하며, 스페큘러 간접광은 뷰를 모르는 베이크의 원리적 한계로 라이트맵에 없다. 움직이는 오브젝트는 같은 커널로 구운 볼류메트릭 라이트맵(3밴드 SH 브릭)이 같은 디퓨즈 자리에 공급된다.</p>
<p><strong>Lumen과의 차이:</strong> Lumen은 같은 적분을 실시간에 풀기 위해 지오메트리(SDF)·히트 셰이딩(Surface Cache 룩업)·적분(1/16 해상도 프로브 + 10프레임 시간 누적)·바운스(캐시 피드백 루프)를 전부 근사로 바꿨고, 알베도 클램프·스카이라이트 leaking 같은 비물리적 안정화 장치를 명시적으로 갖고 있다. <strong>방정식 충실도로는 GPU Lightmass가 더 물리 기반이지만</strong>, 그 정확도는 정적 씬·디퓨즈 항이라는 좁은 정의역 안에서만 유효하다. 둘은 우열 관계가 아니라, 같은 방정식을 서로 다른 자리에서 잘라낸 근사다.</p>
</div>

<div class="callout callout-info">
<div class="callout-title">출처</div>
<p>· UE 5.8 소스 — <code>Engine/Plugins/Experimental/GPULightmass/Shaders/Private/LightmapPathTracing.usf</code>(커널·러시안 룰렛·NEE/MIS·누적), <code>LightmapEncoding.ush/.cpp</code>(SH·LogLUVW 인코딩), <code>LightmapOutput.usf</code>(표본 평균), <code>IrradianceCachingCommon.ush</code>, <code>GPULightmassSettings.h</code>(GISamples 등 기본값), <code>Engine/Shaders/Private/LightmapCommon.ush</code> · <code>BasePassPixelShader.usf</code>(런타임 적용), <code>Engine/Shaders/Private/Lumen/</code>(Surface Cache·Screen Probe Gather·클램프류)<br>
· J. Kajiya, "The Rendering Equation", SIGGRAPH 1986<br>
· Epic Games, "GPU Lightmass Global Illumination" / "Lumen Technical Details" 공식 문서, UE 5.1 Release Notes<br>
· D. Wright, "Radiance Caching for Real-Time Global Illumination", SIGGRAPH 2021; Wright et al., "Lumen: Real-time Global Illumination in Unreal Engine 5", SIGGRAPH 2022 Advances in Real-Time Rendering<br>
· Y. O'Donnell, "Precomputed Global Illumination in Frostbite", GDC 2018 (라이트맵 = 렌더링 방정식의 부분해라는 프레이밍)<br>
· K. Narkowicz, "Journey to Lumen" (2022)</p>
</div>
</div>
