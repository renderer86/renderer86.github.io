---
layout: post
title: "실시간 디노이징: 픽셀당 레이 하나로 그림을 완성하는 기술 — SVGF에서 NRD, 그리고 UE5.8까지"
icon: paper
permalink: denoising
categories: Rendering
tags: [Rendering, UnrealEngine, Denoising, RayTracing, PathTracing, SVGF, NRD, ReSTIR, MachineLearning, Lumen, MegaLights]
excerpt: "실시간 레이트레이싱의 예산은 픽셀당 레이 한 개 남짓이다. 그 1 spp의 몬테카를로 노이즈를 완성된 이미지로 재구성하는 것이 디노이저의 일이고, 지난 10년간 이 분야는 하나의 계보로 정리된다 — 분산 추정치로 필터 폭을 정하는 SVGF(2017), 고정 누적률의 고스팅을 temporal gradient로 고친 A-SVGF(2018), 분산 추적을 아예 버리고 누적 프레임 수로 대신한 NVIDIA ReBLUR, ReSTIR 신호 전용으로 파생된 ReLAX, à-trous 계보를 명시적으로 계승한 AMD FidelityFX, 그리고 hand-tuned 디노이저 전체를 신경망 하나로 대체하겠다는 DLSS Ray Reconstruction까지. 이 글은 검증된 1차 문헌으로 흐름을 정리한 뒤, UE 5.8 소스를 직접 열어 언리얼이 어느 쪽에 가까운지 확인한다 — 레거시 레이트레이싱의 Screen Space Denoiser(SVGF가 아니다!), 디노이징을 파이프라인 전체에 분산시킨 Lumen/MegaLights, 그리고 디노이저를 플러그인으로 추상화한 Path Tracer(NFOR·OIDN·OptiX·NNE)까지."
back_color: "#ffffff"
img_name: "denoising.webp"
toc: false
show: true
new: true
series: -1
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 레이트레이싱 스크린샷마다 따라붙는 "디노이저"가 정확히 무슨 계산을 하는지 궁금한 분
> - SVGF, A-SVGF, NRD, ReBLUR, ReLAX 같은 이름들이 어떤 관계인지 계보로 정리하고 싶은 분
> - ReSTIR가 있으면 디노이저가 필요 없는 것 아닌지 궁금했던 분 (아니다 — 그리고 그 이유가 흥미롭다)
> - DLSS Ray Reconstruction이 기존 디노이저와 뭐가 다른지, hand-tuned vs ML의 트레이드오프가 궁금한 분
> - UE에서 `r.Shadow.Denoiser.*`, `r.Lumen.Reflections.BilateralFilter.*`, `r.PathTracing.Denoiser` 같은 CVar가 각각 어떤 시스템의 어느 단계를 건드리는지 알고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - 몬테카를로 노이즈의 정체와, 모든 실시간 디노이저가 공유하는 세 개의 지렛대(시간 누적·공간 필터·보조 신호)
> - SVGF의 전체 구조 — 모멘트 기반 분산 추정(σ² = μ₂′−μ₁′²)으로 5단계 à-trous wavelet의 edge-stopping 가중치를 정하는 방식, 그리고 저자들이 논문에 직접 쓴 다섯 가지 실패 모드
> - A-SVGF가 "같은 난수 시드로 다시 셰이딩"하는 temporal gradient로 고정 누적률 α를 픽셀별 적응값으로 바꾼 원리
> - NVIDIA NRD의 두 갈래 — 분산 추적을 버린 ReBLUR(recurrent blur, 누적 프레임 수 기반 반경)와 SVGF 직계 ReLAX(RTXDI 전용), 스페큘러를 위한 virtual motion reprojection
> - ReSTIR와 디노이저가 대체가 아니라 보완 관계인 이유 — 리샘플링된 신호의 hitT를 디노이저에 그대로 넘기면 안 되는 문제
> - OIDN·OptiX·DLSS Ray Reconstruction으로 이어지는 ML 디노이저의 접근과, NVIDIA가 hand-tuned 디노이저의 한계로 직접 지목한 것들
> - UE 5.8의 세 갈래 전략 — SSD의 hit distance 기반 커널(분산 추정이 아니다), 노이즈를 디노이저 이전에 설계로 줄이는 Lumen, 디노이저를 플러그인으로 연 Path Tracer — 를 소스 코드 줄 번호로 확인

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.dn-post {
  --bg2: #f3f4fb;
  --surface: #f8f9fd;
  --surface2: #edeef9;
  --border: rgba(88,68,214,0.10);
  --border2: rgba(88,68,214,0.24);
  --text: #1b1c2e;
  --text2: #45475f;
  --text3: #85879c;
  --accent: #5844d6;
  --accent2: #0e9bb3;
  --gold: #b07d00;
  --teal: #0a8f72;
  --coral: #d6304a;
}
.dn-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.dn-post .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.dn-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.dn-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.dn-post .card.blue::before  { background: var(--accent); }
.dn-post .card.gold::before  { background: var(--gold); }
.dn-post .card.teal::before  { background: var(--teal); }
.dn-post .card.coral::before { background: var(--coral); }
.dn-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.dn-post .card.blue  .card-label { color: var(--accent); }
.dn-post .card.gold  .card-label { color: var(--gold); }
.dn-post .card.teal  .card-label { color: var(--teal); }
.dn-post .card.coral .card-label { color: var(--coral); }
.dn-post .card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.dn-post .card-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.dn-post .image-triptych {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 22px 0 26px;
}
.dn-post .image-panel {
  margin: 0;
}
.dn-post .image-panel img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
  border-radius: 8px;
  border: 1px solid var(--border2);
}
.dn-post .image-panel figcaption {
  margin-top: 7px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text2);
}
@media (max-width: 760px) {
  .dn-post .image-triptych { grid-template-columns: 1fr; }
}
.dn-post .callout {
  border-radius: 12px;
  padding: 16px 20px;
  margin: 20px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.dn-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.dn-post .callout-info { background: rgba(88,68,214,0.05); border-color: rgba(88,68,214,0.18); }
.dn-post .callout-info::before { background: var(--accent); }
.dn-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.dn-post .callout-warn::before { background: var(--gold); }
.dn-post .callout-teal { background: rgba(10,143,114,0.05); border-color: rgba(10,143,114,0.20); }
.dn-post .callout-teal::before { background: var(--teal); }
.dn-post .callout-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.dn-post .callout-info .callout-title { color: var(--accent); }
.dn-post .callout-warn .callout-title { color: var(--gold); }
.dn-post .callout-teal .callout-title { color: var(--teal); }
.dn-post .callout p { margin: 0 0 8px 0; font-size: 13px; color: var(--text2); line-height: 1.75; }
.dn-post .callout p:last-child { margin: 0; }
.dn-post .code-block {
  background: #1e2230;
  border: 1px solid rgba(120,140,200,0.15);
  border-radius: 12px;
  padding: 20px 22px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.85;
  overflow-x: auto;
  margin: 18px 0;
  position: relative;
  white-space: pre;
  color: #c8d0ea;
}
.dn-post .code-block .kw  { color: #a78bfa; }
.dn-post .code-block .fn  { color: #34d399; }
.dn-post .code-block .cm  { color: #525a78; font-style: italic; }
.dn-post .code-block .num { color: #fb923c; }
.dn-post .code-block .str { color: #fbbf24; }
.dn-post .code-block .ty  { color: #38bdf8; }
.dn-post .code-lang {
  position: absolute;
  top: 10px; right: 14px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #525a78;
}
.dn-post .flow-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 24px 0;
  overflow-x: auto;
}
.dn-post .flow-step {
  flex: 1;
  min-width: 118px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 14px 16px;
  position: relative;
  text-align: center;
}
.dn-post .flow-step .step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 4px;
}
.dn-post .flow-step .step-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.dn-post .flow-step .step-desc {
  font-size: 11px;
  color: var(--text2);
  line-height: 1.5;
}
.dn-post .flow-arrow {
  display: flex;
  align-items: center;
  padding: 0 6px;
  color: var(--text3);
  font-size: 18px;
  flex-shrink: 0;
}
.dn-post .flag-badge {
  display: inline-block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 5px;
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.dn-post .flag-coral { background: rgba(214,48,74,0.12);  color: var(--coral); }
.dn-post .flag-blue  { background: rgba(88,68,214,0.12);  color: var(--accent); }
.dn-post .flag-teal  { background: rgba(10,143,114,0.12); color: var(--teal); }
.dn-post .flag-gold  { background: rgba(176,125,0,0.12);  color: var(--gold); }
.dn-post .flag-cyan  { background: rgba(14,155,179,0.12); color: var(--accent2); }
.dn-post .flag-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 14px; }
.dn-post .data-table { overflow-x: auto; margin: 24px 0; }
.dn-post .data-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dn-post .data-table th {
  padding: 10px 14px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--accent);
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
}
.dn-post .data-table td { padding: 9px 14px; border: 1px solid var(--border); color: var(--text2); }
.dn-post .data-table tr:nth-child(even) td { background: var(--surface); }
.dn-post .data-table code { font-size: 12px; }
.dn-post .formula {
  background: var(--surface2);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 14px 18px;
  margin: 16px 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 13.5px;
  color: var(--text);
  overflow-x: auto;
  white-space: pre;
  line-height: 1.9;
}
</style>

<div class="dn-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: 픽셀당 레이 하나라는 예산

<div class="dn-post">
<p style="color:var(--text2);line-height:1.85;">
오프라인 렌더러는 픽셀 하나에 수천 개의 경로를 쏘아 <a href="/d8c73243c492ed7b5f44b70936cfe4521669ad34">렌더링 방정식</a>의 적분을 수렴시킨다. 실시간은 그럴 수 없다 — 60fps 예산 안에서 그림자·반사·GI까지 감당하려면 픽셀당 쓸 수 있는 레이는 <strong>한 개 남짓</strong>이다. 몬테카를로 적분을 샘플 하나로 끊으면 남는 것은 정답의 "기대값"을 중심으로 요동치는 노이즈다. 이 1 spp(sample per pixel)의 몬테카를로 노이즈가 가득한 이미지를 완성된 프레임으로 <strong>재구성(reconstruction)</strong>하는 것이 디노이저의 일이고, 하드웨어 레이트레이싱이 실용화된 지난 10년 동안 실시간 렌더링에서 가장 치열하게 발전한 분야 중 하나다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 글은 두 부분으로 되어 있다. 전반부(02~07장)는 업계 표준 계보를 1차 문헌으로 따라간다 — 분산 추정치로 필터 폭을 정하는 <strong>SVGF</strong>(2017), 그 고스팅을 고친 <strong>A-SVGF</strong>(2018), NVIDIA가 실제 게임에 넣으며 분산 추적을 버린 <strong>NRD ReBLUR</strong>와 ReSTIR 전용 <strong>ReLAX</strong>, AMD <strong>FidelityFX</strong>, 그리고 이 모든 수제 필터를 신경망으로 대체하겠다는 <strong>DLSS Ray Reconstruction</strong>. 후반부(08장~)는 UE 5.8 소스를 직접 열어 언리얼이 어느 쪽에 가까운지 확인한다 — 결론부터 말하면 UE는 "SVGF를 쓴다"는 흔한 추측과 달리, <strong>세 가지 서로 다른 전략을 신호별로 골라 쓰는</strong> 쪽에 가깝다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>업계 기법은 1차 문헌만 근거로 했다 — SVGF/A-SVGF 원논문(Schied et al., HPG 2017/2018), NRD 공식 GitHub·GTC 2020 발표(Zhdan)·Ray Tracing Gems II 49장, AMD GPUOpen 공식 문서, ReSTIR GI 논문(Ouyang et al. 2021), NVIDIA DLSS 3.5 공식 발표, Intel OIDN GitHub. 주요 주장은 웹 딥리서치 파이프라인에서 소스 원문 대조로 검증한 것들이다(각 장의 인용 참고). UE 파트는 전부 UE 5.8 로컬 소스(<code>ScreenSpaceDenoise.cpp/.usf</code>, <code>Lumen/*</code>, <code>MegaLights/*</code>, <code>PathTracingDenoiser.h</code>, 디노이저 플러그인 4종)를 직접 읽고 파일:줄 번호로 인용했다.</p>
</div>

<span class="section-eyebrow">01 — 문제의 구조</span>
</div>

# 몬테카를로 노이즈와 세 개의 지렛대

<div class="dn-post">
<p style="color:var(--text2);line-height:1.85;">
몬테카를로 추정량의 분산은 샘플 수 N에 반비례해서 줄어든다. 표준편차 기준으로는 √N — 노이즈를 절반으로 줄이려면 샘플이 4배 필요하다는 뜻이다. 픽셀당 1개인 샘플을 프레임 안에서 4000개로 늘릴 방법은 없으므로, 모든 실시간 디노이저는 결국 <strong>"모자란 샘플을 어디서 빌려올 것인가"</strong>라는 같은 질문에 대한 서로 다른 답이다. 빌릴 곳은 세 군데뿐이다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">시간축 — temporal</div>
<div class="card-title">지난 프레임에서 빌린다</div>
<div class="card-desc">모션 벡터로 히스토리를 재투영해 지수이동평균(EMA)으로 누적하면 유효 샘플 수가 프레임 수만큼 늘어난다. 공짜에 가깝지만 대가가 있다 — 씬이 변하면 히스토리는 거짓말이 되고, 그 결과가 고스팅(ghosting)과 반응 지연(temporal lag)이다.</div>
</div>
<div class="card gold">
<div class="card-label">공간축 — spatial</div>
<div class="card-title">이웃 픽셀에서 빌린다</div>
<div class="card-desc">주변 픽셀도 같은 적분의 다른 샘플이라 치고 섞는다. 다만 서로 다른 표면의 샘플을 섞으면 경계가 뭉개지므로, 깊이·법선 같은 가이드로 "같은 표면일 때만" 빌리는 edge-stopping 가중치가 필수다. 대가는 과다 블러.</div>
</div>
<div class="card teal">
<div class="card-label">보조 신호 — guides</div>
<div class="card-title">노이즈 없는 정보로 안내한다</div>
<div class="card-desc">래스터로 만든 G-buffer(깊이·법선·알베도·모션 벡터)는 노이즈가 없다. 필터 가중치의 가이드로 쓰고, 알베도는 필터링 전에 나눠 뒀다가(demodulation) 끝나고 다시 곱해 텍스처 디테일이 블러에 갈리는 것을 막는다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
셋 중 무엇도 공짜가 아니라서, 디노이저 설계는 결국 <strong>고스팅 ↔ 노이즈 ↔ 블러</strong>의 삼각 트레이드오프 위에서 균형점을 고르는 일이 된다. 시간축을 세게 누르면 고스팅이, 공간축을 세게 누르면 블러가, 둘 다 약하게 하면 노이즈가 남는다. 이 관점 하나만 들고 가면 아래 모든 기법이 "삼각형 위의 좌표"로 읽힌다. 참고로 시간축 재투영과 히스토리 신뢰 판정 자체는 <a href="/tsr">TSR 글</a>에서 다룬 TAA 계열과 인프라를 공유한다 — 디노이저가 다른 점은, 입력이 앨리어싱이 아니라 <strong>확률적 노이즈</strong>라서 공간 재구성 필터의 비중이 훨씬 크다는 것이다.
</p>

<span class="section-eyebrow">02 — 계보의 기준점</span>
</div>

# SVGF: 분산으로 필터 폭을 정한다

<div class="dn-post">
<div class="flag-row"><span class="flag-badge flag-blue">Schied et al., HPG 2017</span><span class="flag-badge flag-gold">1 spp 패스트레이싱</span><span class="flag-badge flag-teal">à-trous wavelet</span></div>

<p style="color:var(--text2);line-height:1.85;">
SVGF(Spatiotemporal Variance-Guided Filtering)는 이후 모든 논의의 기준점이다. 입력으로 next-event estimation을 쓴 <strong>1 spp 패스트레이싱 전역조명</strong>과 노이즈 없는 래스터 G-buffer(깊이·법선·메시 ID·모션 벡터)를 받고, 시간적으로 안정된 이미지 시퀀스를 만든다. 당시 하드웨어(TITAN X Pascal) 기준 1080p에서 약 10ms에 돌았다. 핵심 아이디어는 이름 그대로다 — <strong>픽셀별 분산(variance) 추정치로 공간 필터의 폭을 정한다</strong>. 노이즈가 심한 곳(분산 큼)은 넓게 뭉개고, 이미 수렴한 곳(분산 작음)은 건드리지 않는다.
</p>

<div class="image-triptych">
  <figure class="image-panel">
    <img src="/assets/img/post/denoising/svgf-1spp-noisy.webp" alt="에펠탑 배경의 1 spp noisy render">
    <figcaption>1 spp 입력. 샘플이 부족해 하늘, 그림자, 반사에 몬테카를로 노이즈가 남는다.</figcaption>
  </figure>
  <figure class="image-panel">
    <img src="/assets/img/post/denoising/svgf-variance-map.webp" alt="에펠탑 장면의 픽셀별 분산 맵">
    <figcaption>분산 맵. 밝은 영역은 아직 불안정하므로 더 넓은 공간 필터가 필요하다.</figcaption>
  </figure>
  <figure class="image-panel">
    <img src="/assets/img/post/denoising/svgf-adaptive-result.webp" alt="SVGF 적응형 필터링 결과">
    <figcaption>적응형 필터 결과. 노이즈가 큰 영역은 부드럽게 섞고, 안정된 경계는 보존한다.</figcaption>
  </figure>
</div>

<div class="flow-row">
<div class="flow-step">
<div class="step-num">1</div>
<div class="step-name">Demodulate</div>
<div class="step-desc">알베도를 나눠 조명만 남긴다. 직접광/간접광 분리 필터링</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">2</div>
<div class="step-name">Temporal 누적</div>
<div class="step-desc">색 + 휘도의 1차·2차 모멘트를 α=0.2 EMA로 누적</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">3</div>
<div class="step-name">분산 추정</div>
<div class="step-desc">σ² = μ₂′−μ₁′². 히스토리 4프레임 미만이면 7×7 공간 분산으로 폴백</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">4</div>
<div class="step-name">à-trous ×5</div>
<div class="step-desc">5×5 cross-bilateral을 구멍 뚫린 간격으로 5회 — 유효 65×65</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">5</div>
<div class="step-name">히스토리 갱신</div>
<div class="step-desc">첫 번째 wavelet 반복의 출력이 다음 프레임의 color history가 된다</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
분산은 통계학 그대로 <strong>모멘트로 추정</strong>한다. 휘도와 휘도 제곱(1차·2차 raw moment)을 각각 시간 누적해 두면:
</p>

<div class="formula">σ′²ᵢ = μ₂′ᵢ − (μ₁′ᵢ)²      (분산 = 제곱의 평균 − 평균의 제곱)</div>

<p style="color:var(--text2);line-height:1.85;">
à-trous(아트루스, "구멍 뚫린") wavelet은 5×5 커널을 반복하되 매 반복마다 샘플 간격을 2배로 벌리는 방식이다 — 5회 반복이면 실질 footprint가 65×65인데 비용은 5×5 다섯 번 값만 낸다. 각 탭의 가중치는 세 edge-stopping 함수의 곱이다:
</p>

<div class="formula">w(p,q) = w_z · w_n · w_l
  w_z : 깊이 — 클립공간 깊이 그래디언트 기반 로컬 선형 모델 (σ_z = 1)
  w_n : 법선 — max(0, n_p·n_q)^σ_n (σ_n = 128)
  w_l : 휘도 — exp(−|l_p−l_q| / (σ_l·√(g₃ₓ₃(σ²)) + ε)) (σ_l = 4)</div>

<p style="color:var(--text2);line-height:1.85;">
가장 중요한 항은 휘도 가중치인 <code>w_l</code>이다 — 휘도 차이를 <strong>분산으로 정규화</strong>하기 때문에, 노이즈가 심한 영역에서는 큰 휘도 차이도 "노이즈일 뿐"으로 취급되어 넓게 섞이고, 수렴한 영역에서는 작은 차이도 실제 조명 경계로 인식되어 필터가 멈춘다. 이 세 σ 파라미터는 장면 불변 고정값이고 사용자에게 노출되지 않는다 — "튜닝 없는 디노이저"라는 것도 SVGF의 셀링 포인트였다.
</p>

<div class="callout callout-warn">
<div class="callout-title">저자들이 직접 쓴 다섯 가지 실패 모드 (논문 6절)</div>
<p><strong>① 움직이는 지오메트리에서 그림자가 분리·고스팅된다</strong> — 시간 누적은 조명 변화를 모션 벡터로 알 수 없다. <strong>② 노이즈 낀 스페큘러 반사의 과다 블러</strong>. <strong>③ 카메라 이동 중 날카로운 특징(하드 섀도 등)의 과다 블러</strong>. <strong>④ 아주 어두운 간접광 영역의 시간적으로 불안정한 노이즈</strong>. <strong>⑤ 노이즈 없는 G-buffer를 요구하므로 확률적 primary ray 효과(stochastic transparency, DoF, 모션 블러)와 비호환</strong>. 이 목록이 그대로 이후 10년의 연구 어젠다가 된다 — ①은 A-SVGF가, ②는 NRD의 virtual motion이 정면으로 공략하는 문제다.</p>
</div>

<span class="section-eyebrow">03 — 고스팅의 해부</span>
</div>

# A-SVGF: 같은 난수로 다시 셰이딩해 보면 안다

<div class="dn-post">
<div class="flag-row"><span class="flag-badge flag-blue">Schied et al., HPG 2018</span><span class="flag-badge flag-teal">temporal gradient</span><span class="flag-badge flag-gold">Quake II RTX 채택</span></div>

<p style="color:var(--text2);line-height:1.85;">
SVGF의 시간 누적률 α=0.2는 <strong>상수</strong>다. 조명이 급변해도 새 프레임은 20%씩만 반영되니, 그림자가 움직이면 잔상이 몇 프레임을 끌며 따라온다 — 논문 표현으로 "이는 필연적으로 고스팅과 temporal lag로 이어진다". SVGF 1저자 본인이 이듬해 낸 A-SVGF의 답은: <strong>α를 픽셀별 적응값으로 바꾸되, "조명이 변했는지"를 노이즈에 속지 않고 판별할 방법을 만들자</strong>는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
문제의 핵심은 몬테카를로 노이즈 속에서 "진짜 신호 변화"를 골라내는 것이다. 이전 프레임과 현재 프레임의 셰이딩 값을 그냥 비교하면 난수가 달라서 생긴 차이와 조명이 변해서 생긴 차이를 구분할 수 없다. A-SVGF의 트릭은 감탄스러울 만큼 직접적이다 — <strong>이전 프레임의 표면 샘플을 현재 프레임으로 가져와(forward projection), 이전 프레임과 똑같은 난수 시퀀스로 다시 셰이딩해 본다</strong>(픽셀당 PRNG 시드 하나만 저장하면 된다):
</p>

<div class="image-triptych">
  <figure class="image-panel">
    <img src="/assets/img/post/denoising/asvgf-temporal-ghosting.webp" alt="고정 temporal 누적률로 인해 잔상이 남은 에펠탑 장면">
    <figcaption>고정 누적률. 조명이나 그림자가 바뀌어도 히스토리가 천천히 빠져 잔상이 남는다.</figcaption>
  </figure>
  <figure class="image-panel">
    <img src="/assets/img/post/denoising/asvgf-temporal-gradient.webp" alt="A-SVGF temporal gradient 변화 감지 맵">
    <figcaption>Temporal gradient. 같은 난수로 다시 셰이딩해 노이즈가 아니라 실제로 변한 픽셀을 찾는다.</figcaption>
  </figure>
  <figure class="image-panel">
    <img src="/assets/img/post/denoising/asvgf-adaptive-history.webp" alt="A-SVGF 적응형 히스토리 가중치 결과">
    <figcaption>적응형 누적. 변한 곳은 히스토리를 빨리 버리고, 안정된 곳은 계속 누적한다.</figcaption>
  </figure>
</div>

<div class="formula">δ = f_i(G_{i−1}, ξ_{i−1}) − f_{i−1}(G_{i−1}, ξ_{i−1})
    같은 표면(G), 같은 난수(ξ) — 다른 것은 "장면의 시간"뿐.
    장면이 안 변했으면 δ는 정확히 0. δ ≠ 0이면 조명이 변한 것이다.</div>

<p style="color:var(--text2);line-height:1.85;">
이 temporal gradient 샘플은 비싸므로(셰이딩을 한 번 더 하니까) 화면 전체가 아니라 <strong>3×3 픽셀 스트라텀당 최대 1개</strong>, 즉 전체 샘플의 최대 ~11%만 뽑는다 — 셰이딩 예산의 일부를 전용하는 것이다. 2×2(25%)는 난수의 blue-noise 특성을 훼손하고, 4×4는 그래디언트 해상도가 부족하다고 논문이 명시한다. 희소한 gradient는 SVGF와 같은 edge-stopping 가중치를 쓰는 à-trous joint-bilateral 필터로 조밀한 필드로 재구성되고, 최종적으로 히스토리 가중치가 된다:
</p>

<div class="formula">λ(p) = min(1, |δ̂| / Δ̂),  Δ = max(f_i, f_{i−1})
α_i(p) = (1−λ)·α + λ      → λ=0이면 평소의 α, λ=1이면 히스토리 완전 폐기</div>

<p style="color:var(--text2);line-height:1.85;">
그림자가 지나가는 픽셀, 켜지고 꺼지는 광원 아래의 픽셀은 λ가 커져 히스토리를 즉시 버리고, 정적인 영역은 λ≈0으로 최대한 누적한다. 전체 temporal 필터가 Titan Xp 1080p 기준 2ms 미만, gradient 샘플링+재구성은 1ms 미만. 논문 스스로는 고스팅의 "제거"가 아니라 <strong>유의미한 감소</strong>라고 표현하며, NVIDIA의 Quake II RTX가 이 방식을 채택했다(<code>asvgf.glsl</code>). 뒤에서 보겠지만 이 "적응형 히스토리 신뢰도" 아이디어는 형태만 바꿔 모든 후속 디노이저에 들어간다.
</p>

<span class="section-eyebrow">04 — 벤더 라이브러리 ①</span>
</div>

# NVIDIA NRD: 분산 추적을 버린 ReBLUR, SVGF를 계승한 ReLAX

<div class="dn-post">
<div class="flag-row"><span class="flag-badge flag-blue">github.com/NVIDIA-RTX/NRD</span><span class="flag-badge flag-gold">GTC 2020 (Zhdan)</span><span class="flag-badge flag-teal">Ray Tracing Gems II ch.49</span></div>

<p style="color:var(--text2);line-height:1.85;">
NRD(NVIDIA Real-Time Denoisers)는 "1 path/pixel 패스트레이싱을 주 타깃으로 하는 API-agnostic 시공간 디노이징 라이브러리"라는 것이 공식 정의다(0.5~1 rpp 모드까지 지원). 논문이 아니라 <strong>게임 프로덕션 통합을 목표로 만들어진 벤더 라이브러리</strong>라는 점이 학술 계보와의 결정적 차이인데(원형이 된 GTC 2020 발표의 감사 명단에 4A Games 엔지니어가 올라 있을 만큼 게임 현장과 밀착해 개발됐다), 흥미롭게도 내부에 <strong>설계 철학이 정반대인 디노이저 두 개</strong>가 공존한다. README의 한 줄 요약이 이미 모든 것을 말한다 — "REBLUR: recurrent blur based denoiser / RELAX: A-trous based denoiser, has been designed for RTXDI".
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">ReBLUR</div>
<div class="card-title">분산 추정? 그런 것 없다</div>
<div class="card-desc">디퓨즈·스페큘러 담당. SVGF의 핵심인 분산 추적을 <strong>완전히 버리고</strong>, "몇 프레임이나 성공적으로 누적했는가"라는 카운터 하나로 블러 반경을 정한다. 발표 슬라이드 원문: "no temporal or spatial variance tracking".</div>
</div>
<div class="card teal">
<div class="card-label">ReLAX</div>
<div class="card-title">SVGF의 직계, RTXDI 전용</div>
<div class="card-desc">à-trous 기반 — Ray Tracing Gems II 표현으로 "SVGF의 발전형(advanced version), 주 특징은 fast history 클램핑". ReSTIR 기반 RTXDI 출력이나 매우 깨끗한 고 rpp 신호에 맞춰 설계됐다(06장).</div>
</div>
<div class="card gold">
<div class="card-label">SIGMA</div>
<div class="card-title">그림자 전용</div>
<div class="card-desc">라이트별(per-light) 그림자 전용 디노이저. 태양·달 같은 무한광과 옴니/스팟 로컬 라이트, 반투명 통과까지 담당. "무엇을 디노이징하느냐에 따라 디노이저를 나눈다"는 신호 특화 원칙의 표본.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
ReBLUR의 출발점이 흥미롭다. SVGF의 분산 추정은 disocclusion 직후 몇 프레임 동안 부정확하고(공간 폴백으로 때운다), 그 추정 자체에 메모리와 계산이 든다. Zhdan의 GTC 2020 발표는 이걸 뒤집는다 — <strong>분산이 큰 곳이 어디인지 우리는 이미 안다. 히스토리가 짧은 곳이다</strong>:
</p>

<div class="code-block"><div class="code-lang">GTC 2020 슬라이드 원문 (ReBLUR의 원형)</div><span class="cm">// Adaptive blur radius depends on number of successfully accumulated frames</span>
<span class="cm">// → no temporal or spatial variance tracking</span>
<span class="ty">float</span> blurRadiusScale = <span class="num">1.0</span> / ( <span class="num">1.0</span> + newCount );  <span class="cm">// disocclusion 직후 최대, 누적이 쌓이면 최소</span></div>

<p style="color:var(--text2);line-height:1.85;">
그리고 이름의 유래인 <strong>recurrent blur</strong>: 공간 필터를 노이즈 입력이 아니라 <strong>지난 프레임의 "깨끗한" 최종 출력을 배경 삼아</strong> 돌린다. 공간 필터의 결과가 다시 temporal 피드백 루프로 들어가므로, 프레임당 8개짜리 희소 Poisson disk 커널로도 시간이 지나면 누적 효과로 수백 샘플어치가 된다(30fps면 초당 240샘플). 처음엔 흐리게 시작해서 빠르게 수렴하는 계층적 디노이저다. 전체 파이프라인은 Pre-blur(고정 반경, 아웃라이어 제거) → Accumulation(최대 32프레임 선형 가중) → Mip 생성+History fix(disocclusion 영역을 밉 체인으로 재구성) → Blur → Post-blur(적응 반경) → <strong>Temporal stabilization</strong>(TAA식 분산 클램프 필터 — 누적과 별개 단계로, 추가 지연 없이 출력만 안정화).
</p>

<p style="color:var(--text2);line-height:1.85;">
SVGF의 실패 모드 ②(스페큘러 과다 블러)에 대한 답도 여기 있다. 반사의 히스토리는 표면을 따라 움직이지 않는다 — 반사"상"은 가상 이미지 위치를 따라 움직인다. ReBLUR는 표면 모션 재투영과 <strong>virtual motion 재투영</strong>을 병행한다:
</p>

<div class="code-block"><div class="code-lang">HLSL — Ray Tracing Gems II ch.49 (스페큘러 가상 위치)</div><span class="ty">float3</span> <span class="fn">GetXvirtual</span>( <span class="ty">float3</span> X, <span class="ty">float3</span> V, <span class="ty">float</span> NoV, <span class="ty">float</span> roughness, <span class="ty">float</span> hitDist )
{
    <span class="ty">float</span> f = <span class="fn">GetSpecularDominantFactor</span>( NoV, roughness );
    <span class="kw">return</span> X - V * hitDist * f;  <span class="cm">// 거울이면 히트 지점까지 완전히, 러프해질수록 표면 쪽으로</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
표면 아래 hit distance만큼 들어간 가상 포인트를 재투영하면 반사상의 시차(parallax)가 맞는다. 법선·러프니스·hit distance의 일치도로 "virtual motion 신뢰도"를 만들어 낮으면 분산 색 클램프를 세게 걸고 누적을 가속한다 — <a href="/tsr">TSR</a>의 rejection 휴리스틱과 정확히 같은 사고방식이 스페큘러 히스토리에 적용된 것이다. 스페큘러 누적 속도 자체도 parallax·NoV·러프니스의 함수이고, 블러 반경은 hit distance로 추가 스케일된다("반사된 세계가 가까울수록 반사는 날카롭다").
</p>

<span class="section-eyebrow">05 — 벤더 라이브러리 ②</span>
</div>

# AMD FidelityFX: à-trous 계보의 실용주의

<div class="dn-post">
<div class="flag-row"><span class="flag-badge flag-blue">GPUOpen FidelityFX Denoiser</span><span class="flag-badge flag-teal">shadow + reflection</span></div>

<p style="color:var(--text2);line-height:1.85;">
AMD 쪽 대응물인 FidelityFX Denoiser는 범용 디노이저가 아니라 <strong>Shadow Denoiser와 Reflection Denoiser 두 개의 특화 컴포넌트</strong>다(단일 광원을 향한 지터된 그림자 레이 / 러프니스 기반 지터된 반사 레이가 각각의 입력). 계보 면에서 정직한 것이 특징인데, 공식 문서가 Edge-Avoiding À-Trous Wavelet과 SVGF 방법론을 참조했다고 명시한다 — 반복할수록 반경이 커지는 EAW 블러, 분산 유도 필터링(temporal 샘플 수가 적을 때 적응적으로 부스트), 고스팅 방지용 neighborhood clamping. 여기에 실전형 최적화가 얹힌다:
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">Tile Classifier</div>
<div class="card-title">일 없는 타일은 건너뛴다</div>
<div class="card-desc">그림자 마스크에 공간 분산이 없는(완전히 밝거나 완전히 그림자인) 타일은 필터링 자체를 스킵. 반사 쪽도 비반사 영역 스킵. 디노이징 비용의 대부분이 페넘브라/글로시 영역에만 쓰이게 한다.</div>
</div>
<div class="card teal">
<div class="card-label">Variable Rate Traversal</div>
<div class="card-title">거울은 풀 레이트, 글로시는 1/4</div>
<div class="card-desc">반사 디노이저는 트레이싱 자체와 결합해 미러 반사는 풀 레이트로, 글로시 반사는 쿼터 레이트까지 낮춰 쏜다. Temporal Variance Guided Tracing — 분산이 큰 곳에 레이를 더 주는 피드백 루프.</div>
</div>
<div class="card gold">
<div class="card-label">패스 구조</div>
<div class="card-title">classifier → spatial → temporal → blur</div>
<div class="card-desc">타일 분류 → 공간 필터 → temporal 재투영 → 가우시안 블러의 멀티패스. 구조 자체는 SVGF 골격에 분류기와 가변 레이트를 접목한 형태다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
정리하면 NVIDIA와 AMD 모두 결론은 같다 — <strong>범용 디노이저 하나가 아니라 신호별 특화 디노이저의 묶음</strong>. 그림자에는 그림자의(단일 스칼라 마스크, hit distance로 페넘브라 폭 추정 가능), 반사에는 반사의(러프니스 로브, 가상 시차) 물리적 사전지식이 있고, 그걸 필터에 새겨 넣을수록 같은 샘플 수에서 더 나은 품질이 나온다. 이 원칙은 08장의 UE에서도 그대로 반복된다.
</p>

<span class="section-eyebrow">06 — 샘플링과의 관계</span>
</div>

# ReSTIR는 디노이저를 대체하는가

<div class="dn-post">
<div class="flag-row"><span class="flag-badge flag-blue">Ouyang et al. 2021 (ReSTIR GI)</span><span class="flag-badge flag-teal">RTXDI</span><span class="flag-badge flag-gold">NRD 통합 가이드</span></div>

<p style="color:var(--text2);line-height:1.85;">
<a href="/megalights">MegaLights 글</a>에서 봤듯 ReSTIR 계열은 리저버 기반 리샘플링으로 이웃 픽셀·이전 프레임의 <strong>샘플(후보)을 재사용</strong>해, 같은 레이 예산으로 훨씬 좋은 샘플을 고른다. ReSTIR GI 논문의 수치로 픽셀당 1샘플 기준 MSE가 9.3~166배 개선된다. 그러면 노이즈가 충분히 줄어서 디노이저가 필요 없어지는 것 아닐까?
</p>

<div class="image-triptych">
  <figure class="image-panel">
    <img src="/assets/img/post/denoising/restir-naive-1spp.webp" alt="독립 샘플링으로 노이즈가 심한 에펠탑 직접광 렌더">
    <figcaption>독립 1 spp 샘플링. 픽셀마다 따로 고른 샘플 때문에 고주파 노이즈가 크게 남는다.</figcaption>
  </figure>
  <figure class="image-panel">
    <img src="/assets/img/post/denoising/restir-sample-reuse.webp" alt="ReSTIR 샘플 재사용 후 저주파 얼룩이 남은 에펠탑 렌더">
    <figcaption>ReSTIR 샘플 재사용. 좋은 후보를 공유해 노이즈 양은 줄지만, 상관된 얼룩은 남을 수 있다.</figcaption>
  </figure>
  <figure class="image-panel">
    <img src="/assets/img/post/denoising/restir-plus-denoiser.webp" alt="ReSTIR와 전용 디노이저를 함께 쓴 최종 에펠탑 렌더">
    <figcaption>ReSTIR + 전용 디노이저. 샘플링이 줄인 구멍을 디노이저가 마저 정리한다.</figcaption>
  </figure>
</div>

<p style="color:var(--text2);line-height:1.85;">
1차 문헌의 답은 명확하게 "아니다 — 보완 관계다". ReSTIR GI 논문 초록부터가 "디노이저와 결합하면(in conjunction with a denoiser) 실시간 프레임레이트에서 고품질 패스트레이스 전역조명에 이른다"고 쓴다. ReSTIR를 제품화한 NVIDIA RTXDI는 아예 <strong>전용 디노이저를 짝으로 출시</strong>했다 — 앞 장의 ReLAX가 바로 "RTXDI 신호를 위해 설계된" 디노이저다. 샘플링이 좋아지면 노이즈의 <strong>양</strong>이 줄지만, 0이 되지는 않는다. 그리고 더 미묘한 문제가 있다 — 노이즈의 <strong>성질</strong>이 변한다.
</p>

<div class="callout callout-warn">
<div class="callout-title">리샘플링된 신호는 디노이저의 가정을 흔든다</div>
<p>대부분의 디노이저는 픽셀별 노이즈가 서로 독립이라고 암묵적으로 가정한다(분산 추정도, 이웃을 "추가 샘플"로 취급하는 공간 필터도). 그런데 ReSTIR는 정의상 <strong>이웃 픽셀·이전 프레임과 샘플을 공유</strong>하므로 노이즈가 시공간적으로 상관(correlated)된다 — 얼룩덜룩한 저주파 덩어리 노이즈가 생기고, 이웃이 더 이상 "독립적인 추가 샘플"이 아니게 된다. NRD 공식 통합 가이드에 이 문제의 실무 버전이 그대로 등장한다: "RIS/MIS/ReSTIR 같은 고급 샘플링을 쓸 때는 <strong>선택된 샘플의 hitT를 NRD에 그대로 넘기면 안 되고</strong>" BRDF 로브를 기준으로 확률적으로 걸러 넘겨야 한다 — 리샘플링이 고른 샘플의 hit distance는 그 픽셀 로브의 대표값이 아닐 수 있기 때문이다. ReLAX가 별도로 존재하는 이유가 이것이다: ReSTIR 출력은 통계적 성격이 다른 별개의 신호 클래스라서, 그에 맞춘 디노이저가 필요했다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
그래서 현대 실시간 파이프라인의 표준 구도는 <strong>"좋은 샘플링(ReSTIR) + 신호에 맞춘 디노이저(ReLAX류)"의 2단 구성</strong>이다. 샘플링은 디노이저가 메울 구멍을 줄이고, 디노이저는 샘플링이 남긴 잔여 분산을 치운다. UE의 MegaLights도 정확히 이 구도다 — RIS 기반 스토캐스틱 라이트 샘플링 뒤에 전용 temporal+spatial 디노이저가 따라붙는다(08장).
</p>

<span class="section-eyebrow">07 — 머신러닝</span>
</div>

# ML 디노이저: 수제 필터를 통째로 대체하다

<div class="dn-post">
<div class="flag-row"><span class="flag-badge flag-blue">Intel OIDN</span><span class="flag-badge flag-teal">NVIDIA OptiX</span><span class="flag-badge flag-gold">DLSS 3.5 Ray Reconstruction</span></div>

<p style="color:var(--text2);line-height:1.85;">
지금까지의 디노이저는 전부 사람이 설계한 필터다 — 어떤 신호를 가이드로 쓸지, 가중치 함수를 어떻게 세울지, σ를 몇으로 둘지 전부 수작업이다. ML 디노이저는 이 설계 전체를 학습으로 대체한다. 오프라인 쪽에서 먼저 표준이 됐다: <strong>Intel OIDN</strong>(Open Image Denoise)은 CNN 기반 필터로, beauty에 albedo·normal 보조 버퍼를 곁들여 넣으면 1 spp 프리뷰부터 수렴 직전 파이널 프레임까지 커버한다("suitable for both preview and final-frame rendering"). 여러 벤더 CPU/GPU에서 돌고, 자기 데이터셋으로 재학습하는 툴킷도 제공한다. <strong>NVIDIA OptiX AI Denoiser</strong>도 같은 계열의 GPU 가속 디노이저로, 두 쪽 다 원래 무대는 오프라인 렌더러의 인터랙티브 프리뷰였다 — 그리고 09장에서 보듯 UE Path Tracer에는 이 둘이 <strong>플러그인으로 그대로 들어와 있다</strong>.
</p>

<p style="color:var(--text2);line-height:1.85;">
실시간 디노이저 구현에서 주목해야 할 변화는 2023년의 <strong>DLSS 3.5 Ray Reconstruction</strong>이다. NVIDIA의 공식 표현이 도발적이다 — "hand-tuned 디노이저들을 슈퍼컴퓨터로 학습한 AI 네트워크로 대체한다(replacing hand-tuned denoisers with an NVIDIA supercomputer-trained AI network)". 자사의 NRD를 포함한 수제 디노이저 일반의 한계로 지목한 것이: 시간 누적이 과거 프레임에서 틀린 정보를 가져와 고스팅과 동적 효과 손실을 만들고, 공간 보간이 고주파 디테일을 갈아 없애며, 조명 종류마다 수동 튜닝이 필요해 복잡하다는 것 — 정확히 01장의 삼각 트레이드오프다. Ray Reconstruction의 구조적 승부수는 <strong>디노이저와 업스케일러의 통합</strong>이다: 따로 돌리면 디노이저가 업스케일러에 필요한 고주파 정보를 먼저 지워 버리는데, 하나의 네트워크(DLSS 3 대비 5배 데이터로 학습)가 두 일을 같이 하면 그 정보를 끝까지 들고 갈 수 있다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">hand-tuned</div>
<div class="card-title">싸고, 예측 가능하고, 이식 가능하다</div>
<div class="card-desc">동작이 해석 가능하고 아티팩트의 원인을 추적해 CVar로 고칠 수 있다. 벤더 중립(NRD는 API-agnostic, FFX는 오픈소스). 비용이 낮고 콘솔·모바일까지 간다. 대신 신호마다 사람이 새로 설계·튜닝해야 한다.</div>
</div>
<div class="card coral">
<div class="card-label">ML</div>
<div class="card-title">품질 상한이 높고, 통합이 가능하다</div>
<div class="card-desc">수제 휴리스틱이 못 잡는 패턴(복잡한 글로시 반사, 파티클 뒤 조명)을 학습으로 잡고, 업스케일링과의 통합으로 파이프라인 전체를 최적화한다. 대신 블랙박스라 실패 모드를 국소 수정하기 어렵고, 추론 비용과 하드웨어(텐서 코어) 의존이 붙는다.</div>
</div>
</div>

<span class="section-eyebrow">08 — UE 5.8 ①</span>
</div>

# UE의 첫 번째 갈래 — Screen Space Denoiser: SVGF가 아니다

<div class="dn-post">
<div class="flag-row"><span class="flag-badge flag-gold">ScreenSpaceDenoise.cpp (3116줄)</span><span class="flag-badge flag-blue">SSD*.usf/.ush</span><span class="flag-badge flag-teal">레거시 HW RT + SSGI 전용</span></div>

<p style="color:var(--text2);line-height:1.85;">
이제 UE 5.8이다. 언리얼의 디노이징은 하나가 아니라 <strong>세 갈래</strong>고, 갈래마다 앞 장에서 본 방식과 닮은 지점이 다르다. 첫 번째 갈래인 <strong>SSD(Screen Space Denoiser)</strong>는 Lumen 이전 세대의 하드웨어 레이트레이싱 기능들 — 스탠드얼론 RT 그림자·반사·AO·스카이라이트 GI — 과 SSGI가 쓰는 범용 프레임워크다. 진입점은 <code>IScreenSpaceDenoiser</code> 인터페이스(<code>ScreenSpaceDenoise.h:48</code>)로, 신호별 입출력 구조체(<code>FShadowVisibilityInputs</code>, <code>FReflectionsInputs</code>, <code>FAmbientOcclusionInputs</code>, <code>FDiffuseIndirectInputs</code>...)와 <code>Denoise*</code> 가상 함수들을 정의한다. 실제 호출부는 딱 5곳이다 — RT 그림자(<code>LightRendering.cpp:1967, 2255</code>), 반사(<code>IndirectLightRendering.cpp:2306</code>), RT AO(<code>RayTracingAmbientOcclusion.cpp:253</code>), RT 스카이라이트(<code>RaytracingSkylight.cpp:567</code>), SSGI(<code>IndirectLightRendering.cpp:1332</code>). 전역 포인터 <code>GScreenSpaceDenoiser</code>(<code>ScreenSpaceDenoise.h:347</code>)를 서드파티 플러그인이 교체할 수 있게 되어 있다 — NRD 같은 외부 디노이저가 끼어드는 지점이 바로 여기다.
</p>

<p style="color:var(--text2);line-height:1.85;">
모든 신호는 <code>DenoiseSignalAtConstantPixelDensity</code>(<code>ScreenSpaceDenoise.cpp:1365</code>) 하나로 흘러들어 같은 골격의 패스 체인을 탄다:
</p>

<div class="flow-row">
<div class="flow-step">
<div class="step-num">0 · 선택</div>
<div class="step-name">Compress / Injest</div>
<div class="step-desc">메타데이터 압축(SSGI만), 그림자는 injest에서 블러 반경 선계산</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">1</div>
<div class="step-name">Reconstruction</div>
<div class="step-desc">공간 재구성 — "ratio estimator로 히스토리 rejection을 정밀하게" (주석)</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">2 · 0~N회</div>
<div class="step-name">Pre-Convolution</div>
<div class="step-desc">패스마다 커널 간격 2배(1&lt;&lt;n) — à-trous식 확장</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">3</div>
<div class="step-name">Temporal 누적</div>
<div class="step-desc">재투영 + 분산 박스 클램프 (AO만 별도 모멘트 패스로 분산 준비)</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">4 · 선택</div>
<div class="step-name">History Convolution</div>
<div class="step-desc">누적 후 마무리 블러. 그림자는 Final 패스에서 transmission 처리</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
겉모습은 SVGF와 비슷하다 — 공간 재구성이 있고, 반복 컨볼루션이 있고, temporal이 있다. 하지만 소스를 열면 <strong>SVGF·Schied 인용이 단 한 줄도 없고</strong>(전역 grep 0건), 커널 크기를 정하는 원리가 다르다. SVGF의 "분산 추정"이 있어야 할 자리에 UE가 넣은 것은 <strong>ray hit distance에서 해석적으로 유도한 월드 공간 블러 반경</strong>이다. 그림자가 가장 명확한 예다 — 페넘브라의 폭은 물리적으로 광원 크기와 차폐물 거리의 함수이므로, 추정할 필요 없이 <strong>계산</strong>하면 된다:
</p>

<div class="code-block"><div class="code-lang">C++ — ScreenSpaceDenoise.cpp:1643 (그림자: hit distance → 블러 반경 변환 계수)</div><span class="cm">// 광원의 소스각(태양이면 ~0.5°)이 클수록 같은 차폐 거리에서 페넘브라가 넓다</span>
HitDistanceToWorldBluringRadius = <span class="fn">tan</span>(<span class="num">0.5</span> * <span class="fn">DegToRad</span>(LightSourceAngle) * ShadowSourceAngleFactor);</div>

<div class="code-block"><div class="code-lang">HLSL — SSDPublicHarmonics.ush:21 (광원 타입별 페넘브라 폭)</div><span class="cm">// 방향광:  SourceRadius * rsqrt(1 - SourceRadius²) * HitT</span>
<span class="cm">// 점/스팟: SourceRadius * HitT / (DistanceFromLight - HitT)   ← 닮은꼴 삼각형 그대로</span>
<span class="cm">// 렉트:   SmallestLightDimension * HitT / (DistanceFromLight - HitT)</span></div>

<p style="color:var(--text2);line-height:1.85;">
AO와 디퓨즈 GI도 같은 원리로 hit distance 자체를 블러 반경으로 쓴다(<code>SSDSignalFramework.ush:645</code>) — 가까운 차폐물이 만든 음영은 날카롭고 먼 차폐물이 만든 음영은 부드럽다는 물리를 그대로 커널 크기로 옮긴 것이다. 04~05장의 용어로 말하면 UE SSD는 <strong>ReBLUR와 같은 "분산 추정 회피" 진영</strong>인데, ReBLUR가 누적 프레임 수라는 시간축 신호를 썼다면 UE는 hit distance라는 기하 신호를 썼다. 2차 모멘트 기반 분산은 딱 한 곳, AO의 rejection pre-convolution(<code>SSDSpatialAccumulation.usf:430</code>, "history rejection is variance based")에만 남아 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
공간 커널도 à-trous 고정 격자가 아니라 <strong>확률적 샘플 셋</strong>이다 — 재구성 패스는 [Stackowiak 2015/2018]의 56샘플×4셋 스토캐스틱 테이블(<code>SSDSpatialKernel.ush:1536</code>), pre-convolution은 HEXAWEB, 반사는 러프니스 로브를 따라 늘어난 방향성 타원(DIRECTIONAL_ELLIPSE) 커널을 쓴다. 탭별 가중치는 신호별 bilateral 프리셋(<code>SSDSpatialKernel.ush:297</code>)으로 갈리는데, 이 프리셋 표가 "신호의 물리가 필터를 결정한다"는 원칙의 교과서적 사례다:
</p>

<div class="data-table">
<table>
<tr><th>신호</th><th>Bilateral 가중치</th><th>근거 (소스 주석)</th></tr>
<tr><td>그림자</td><td>위치 위주 (+법선 보조)</td><td>"Shadow masks are normal invarient, so only reject based on position" — 그림자는 표면 법선과 무관하다</td></tr>
<tr><td>반사</td><td>Tokuyoshi 러프니스 로브</td><td>[Tokoyashi 2015] 스페큘러 로브의 유사도로 이웃을 거른다 — 러프니스가 다르면 다른 신호</td></tr>
<tr><td>AO / 디퓨즈 GI</td><td>위치 + 법선</td><td>디퓨즈 신호는 표면 방향에 종속</td></tr>
<tr><td>SH (harmonic)</td><td>위치만</td><td>방향 정보가 SH 계수 자체에 인코딩되어 있어 법선 거부가 불필요</td></tr>
</table>
</div>

<div class="callout callout-teal">
<div class="callout-title">주요 CVar (ScreenSpaceDenoise.cpp:26-130)</div>
<p><code>r.Shadow.Denoiser.ReconstructionSamples</code>(8) · <code>.PreConvolution</code>(1) · <code>.TemporalAccumulation</code>(1) / <code>r.Reflections.Denoiser</code>(2 = 교체 가능 디노이저 사용) · <code>.ReconstructionSamples</code>(8) / <code>r.AmbientOcclusion.Denoiser.ReconstructionSamples</code>(16) · <code>.KernelSpreadFactor</code>(4) / <code>r.GlobalIllumination.Denoiser.ReconstructionSamples</code>(16). 재구성 샘플 수가 그림자·반사(8)보다 AO·GI(16)에서 두 배인 것은 디퓨즈 신호의 분산이 그만큼 크기 때문이다.</p>
</div>

<span class="section-eyebrow">09 — UE 5.8 ②</span>
</div>

# 두 번째 갈래 — Lumen과 MegaLights: 디노이저가 아니라 파이프라인

<div class="dn-post">
<div class="flag-row"><span class="flag-badge flag-gold">LumenScreenProbe*.usf/cpp</span><span class="flag-badge flag-blue">LumenReflections.cpp</span><span class="flag-badge flag-cyan">MegaLightsDenoising.cpp</span></div>

<p style="color:var(--text2);line-height:1.85;">
놀랄 사실 하나: <a href="/lumen">Lumen</a>은 방금 본 SSD를 <strong>전혀 호출하지 않는다</strong>. Lumen 디렉터리 전체에서 <code>IScreenSpaceDenoiser</code>의 <code>Denoise*</code> 호출은 0건이고, <code>ScreenSpaceDenoise.h</code>를 include하는 4개 파일은 전부 텍스처 컨테이너 구조체(<code>FSSDSignalTextures</code>)를 반환 타입으로 재사용할 뿐이다(<code>LumenScreenProbeGather.cpp:2196-2202</code>). MegaLights도 마찬가지로 grep 0건. 왜일까? Lumen의 답은 "더 좋은 디노이저"가 아니라 <strong>"디노이저에 도달하기 전에 노이즈를 설계로 줄인다"</strong>이기 때문이다. Screen Probe Gather의 노이즈 예산을 단계별로 따라가 보자.
</p>

<div class="flow-row">
<div class="flow-step">
<div class="step-num">1 · 배치</div>
<div class="step-name">Probe 다운샘플</div>
<div class="step-desc">16×16 픽셀 타일당 probe 1개, probe당 8×8=64레이 → 픽셀당 유효 ~0.25레이</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">2 · 조준</div>
<div class="step-name">Importance Sampling</div>
<div class="step-desc">BRDF PDF × 입사광 PDF로 레이를 중요한 방향에 재배치 — "reduce noise as more rays are reassigned to an important direction" (소스 주석)</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">3 · probe 공간 필터</div>
<div class="step-name">이웃 probe끼리 블렌드</div>
<div class="step-desc">3패스, 위치 가중 × hit 방향 각도 가중(기본 10°). 스크린이 아니라 probe 아틀라스에서</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">4 · 업샘플</div>
<div class="step-name">보간 + 지터</div>
<div class="step-desc">4코너 probe의 depth 가중 bilinear + 풀해상도 지터로 보간 노이즈를 시간축에 분산</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">5 · 시간축</div>
<div class="step-name">Temporal 누적</div>
<div class="step-desc">4-tap validity 가중 히스토리 (자세한 판정은 별도 글에서)</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
포인트는 3단계다. 필터링이 <strong>픽셀 공간이 아니라 probe 공간</strong>에서 일어난다 — 필터 대상이 픽셀 수천 개가 아니라 probe 수백 개이고, 각 probe는 이미 64레이어치 방향 정보를 octahedral 맵으로 들고 있어서 "hit 방향이 10° 이내로 비슷한 이웃 radiance만 빌린다" 같은 각도 기반 가중(<code>LumenScreenProbeFiltering.usf:346-378</code>)이 가능하다. 이웃 probe의 hit distance를 자기 것으로 clamp해 컨택트 그림자가 새는 것도 막는다(<code>:357-361</code>). 스크린 공간 디노이저가 잃어버리는 방향 정보를 유지한 채로 공간 재사용을 하는 셈이다. 반사는 별도의 자체 3단 체인을 탄다 — Resolve(BRDF 재가중 공간 재구성, <code>r.Lumen.Reflections.ScreenSpaceReconstruction</code>) → Temporal → Bilateral(<code>r.Lumen.Reflections.BilateralFilter.KernelRadius</code>=8px, 러프니스가 낮고 radiance cache로 레이가 짧아지는 구조와 결합). ShortRangeAO는 전용 디노이저 없이 gather의 temporal 필터에 편승한다(<code>LumenScreenProbeGatherTemporal.usf:21</code> — "Denoise direction and AO separately for higher quality").
</p>

<p style="color:var(--text2);line-height:1.85;">
<a href="/megalights">MegaLights</a>는 06장의 "ReSTIR + 전용 디노이저" 구도의 UE 구현이다. 파이프라인 순서(<code>MegaLights.cpp:2381</code>)가 TileClassification → GenerateSamples(RIS 스토캐스틱 라이트 샘플링) → RayTrace → Resolve(셰이딩) → <strong>DenoiseLighting</strong> — 리샘플링 뒤에 디노이저가 따라붙는 정석 배치다. 디노이저 내부(<code>MegaLightsDenoising.cpp:436</code>)는 temporal이 먼저다: diffuse/specular 라이팅과 함께 <strong>휘도 2차 모멘트</strong>(<code>LightingMoments</code>)와 누적 프레임 수, 히스토리 신뢰도를 같이 누적한다. 그 다음 spatial(<code>MegaLightsDenoiserSpatial.usf</code>)이 Hammersley 시퀀스로 디스크 커널을 뽑아 3중 가중치로 섞는다:
</p>

<div class="code-block"><div class="code-lang">HLSL — MegaLightsDenoiserSpatial.usf:503-538 (bilateral 3중 가중)</div><span class="cm">// ① 깊이: scene-plane 거리 기반</span>
<span class="ty">float</span> DepthWeight = <span class="fn">exp2</span>(-SpatialFilterDepthWeightScale * <span class="fn">Pow2</span>(RelativeDepthDifference));
<span class="cm">// ② 법선: 디퓨즈는 각도 그대로, 스페큘러는 로브 반각으로 정규화</span>
<span class="ty">float</span> NormalWeight = <span class="num">1</span> - <span class="fn">saturate</span>(AngleBetweenNormals / SpecularLobeHalfAngle);
<span class="cm">// ③ 휘도: 차이를 temporal 모멘트에서 유도한 표준편차로 정규화 — SVGF의 w_l과 같은 골격!</span>
<span class="ty">float</span> LuminanceWeight = <span class="fn">exp2</span>(-(LuminanceDelta / <span class="fn">max</span>(CenterStdDev, eps)));</div>

<p style="color:var(--text2);line-height:1.85;">
③번이 재미있다 — UE에서 <strong>SVGF식 "분산 정규화 휘도 가중"에 가장 가까운 코드</strong>는 SSD가 아니라 MegaLights에 있다. 분산 소스도 이중화되어 있어서 히스토리가 충분하면 temporal 모멘트로, disocclusion 영역에서는 그룹셰어드 메모리로 이웃 모멘트를 모아 공간 분산으로 대체한다(<code>:352-368</code>). 게다가 상대 오차가 작으면(<code>NormalizedStdDev &lt; 0.2</code>) 필터를 아예 스킵하고 잔여 노이즈를 <a href="/tsr">TSR</a>에 넘긴다(<code>:399-417</code>) — FidelityFX의 tile classifier와 같은 "일 없는 곳은 건너뛴다" 발상이다. CVar는 <code>r.MegaLights.Denoiser</code>를 마스터로 <code>r.MegaLights.Temporal.*</code> / <code>r.MegaLights.Spatial.*</code> 계열로 나뉜다(<code>MegaLightsDenoising.cpp:11-123</code>).
</p>

<span class="section-eyebrow">10 — UE 5.8 ③</span>
</div>

# 세 번째 갈래 — Path Tracer: 디노이저를 플러그인으로 열다

<div class="dn-post">
<div class="flag-row"><span class="flag-badge flag-gold">PathTracingDenoiser.h</span><span class="flag-badge flag-blue">NFOR · OIDN · OptiX · NNE</span><span class="flag-badge flag-teal">r.PathTracing.Denoiser.*</span></div>

<p style="color:var(--text2);line-height:1.85;">
Path Tracer는 MRQ 렌더처럼 오프라인에 가까운 용도로 쓰이기 때문에 실시간 렌더링에 비해 시간 예산이 널널하다 — 프레임당 2ms가 아니라 "최종 프레임 품질"이 목표고, 07장의 ML 디노이저 계열들을 주로 쓴다. UE의 선택은 특정 디노이저를 내장하는 대신 <strong>인터페이스를 열어 두는 것</strong>이다. <code>PathTracingDenoiser.h</code>에 두 계약이 있다:
</p>

<div class="code-block"><div class="code-lang">C++ — Engine/Source/Runtime/Renderer/Public/PathTracingDenoiser.h (요약)</div><span class="cm">// 공간 전용 — 입력: Color / Albedo / Normal / Output  (variance 없음)</span>
<span class="kw">struct</span> <span class="ty">IPathTracingDenoiser</span>          { <span class="kw">virtual void</span> <span class="fn">AddPasses</span>(GraphBuilder, View, Inputs) = <span class="num">0</span>; };

<span class="cm">// 시공간 — 추가 입력: Depth / Variance / Flow(광류) / PreviousOutput / PrevHistory</span>
<span class="kw">struct</span> <span class="ty">IPathTracingSpatialTemporalDenoiser</span> {
    <span class="kw">virtual bool</span> <span class="fn">NeedVarianceTexture</span>() <span class="kw">const</span>;   <span class="cm">// variance 텍스처는 요구할 때만 생성된다</span>
    <span class="kw">virtual void</span> <span class="fn">AddPasses</span>(...) = <span class="num">0</span>;
    <span class="kw">virtual void</span> <span class="fn">AddMotionVectorPass</span>(...);
};
<span class="fn">RegisterSpatialDenoiser</span>(MakeUnique&lt;FMyDenoiser&gt;(), TEXT(<span class="str">"MyName"</span>));  <span class="cm">// 플러그인이 StartupModule에서 등록</span></div>

<p style="color:var(--text2);line-height:1.85;">
엔진에 추가되어 있는 플러그인이 넷이다. <strong>NFOR</strong>(<code>Engine/Plugins/Experimental/NFORDenoise</code>, 기본 활성)은 오프라인 디노이징 연구의 고전인 Bitterli et al.의 Nonlinearly Weighted First-Order Regression을 구현한 시공간 디노이저로, albedo/normal/(옵션)depth를 feature로 radiance를 회귀한다 — <code>NeedVarianceTexture()</code>가 true라서 variance 텍스처가 필수다. <strong>OIDN</strong>(2.3.1 동봉, 기본 비활성)은 07장의 그 CNN 디노이저가 spatial 전용(<code>IPathTracingDenoiser</code>)으로 등록되고, <strong>OptiX</strong>는 시공간형으로 CUDA 커널과 함께 들어온다. 가장 최신인 <strong>NNEDenoiser</strong>는 UE의 Neural Network Engine 런타임으로 ONNX 모델을 돌리는데, 동봉 모델이 <strong>OIDN 2.3.0 가중치를 ONNX로 변환한 것</strong>이다(<code>NNE_oidn2-3-0_rt_hdr_alb_nrm...uasset</code>) — 서드파티 DLL 없이 엔진 추론 스택으로 ML 디노이징을 돌리는 방향성이 읽힌다.
</p>

<p style="color:var(--text2);line-height:1.85;">
엔진 측 코드(<code>PathTracingSpatialTemporalDenoising.cpp</code>)는 역할이 명확히 나뉜다 — AOV(albedo/normal) 생성과 variance prepass(<code>r.PathTracing.Denoiser.Prepass.*</code>), 그리고 <strong>자체 temporal 디노이저 + 모션 추정</strong>을 엔진이 담당하고(spatial 디노이징은 <code>:1089</code>에서 활성 플러그인의 <code>AddPasses</code>로 위임), 카메라 공간 법선을 요구하는 디노이저를 위한 변환(<code>r.PathTracing.Denoiser.NormalSpace</code>)까지 챙긴다. 이 temporal 파트가 특이하게도 <strong>모션 벡터 없이</strong> 동작한다 — Hanika et al. 2021의 feature 매칭 기반 재투영에, 히스토리 신뢰 판정으로는 지각 색차(CIEDE2000 ΔE)를 쓴다. 시간축 재사용 일반론과 함께 다룰 가치가 있는 독특한 설계라 이 글에서는 존재만 짚어 둔다(<code>r.PathTracing.TemporalDenoiser.mode</code>, 기본은 오프라인 전용).
</p>

<span class="section-eyebrow">11 — 한눈에</span>
</div>

# 한눈에: 여덟 개의 디노이저, 세 개의 설계 축

<div class="dn-post">
<div class="data-table">
<table>
<tr><th>기법</th><th>계보</th><th>필터 세기의 근거</th><th>Temporal 전략</th><th>특화 신호</th></tr>
<tr><td><strong>SVGF</strong> (2017)</td><td>기준점</td><td>모멘트 기반 분산 추정</td><td>고정 α=0.2 EMA</td><td>1 spp 패스트레이스 GI</td></tr>
<tr><td><strong>A-SVGF</strong> (2018)</td><td>SVGF 직계</td><td>분산 추정 (동일)</td><td>temporal gradient → 픽셀별 적응 α</td><td>동적 조명에 강함</td></tr>
<tr><td><strong>NRD ReBLUR</strong></td><td>탈-SVGF</td><td><strong>누적 프레임 수</strong> (분산 추적 없음)</td><td>recurrent blur + virtual motion + TAA식 안정화</td><td>디퓨즈·스페큘러</td></tr>
<tr><td><strong>NRD ReLAX</strong></td><td>SVGF 발전형</td><td>분산 + fast history 클램프</td><td>이중 히스토리</td><td>RTXDI/ReSTIR 출력</td></tr>
<tr><td><strong>NRD SIGMA</strong></td><td>신호 특화</td><td>—</td><td>—</td><td>라이트별 그림자</td></tr>
<tr><td><strong>AMD FFX</strong></td><td>EAW/SVGF 명시 계승</td><td>분산 유도 + 타일 분류</td><td>재투영 + neighborhood clamp</td><td>그림자 / 반사 별도</td></tr>
<tr><td><strong>DLSS RR</strong></td><td>ML 통합</td><td>학습된 네트워크</td><td>네트워크 내부에서 통합</td><td>디노이징+업스케일 일체</td></tr>
<tr><td><strong>UE SSD</strong></td><td>독자 (탈-SVGF)</td><td><strong>hit distance → 월드 블러 반경</strong> (해석적)</td><td>재투영 + 분산 박스 (AO만 모멘트)</td><td>신호별 bilateral 프리셋</td></tr>
<tr><td><strong>UE Lumen</strong></td><td>디노이저 최소주의</td><td>probe 공간 필터 + importance sampling</td><td>validity 기반 누적 (+반사는 자체 3단)</td><td>GI / 반사</td></tr>
<tr><td><strong>UE MegaLights</strong></td><td>ReSTIR+전용 디노이저 구도</td><td>모멘트 표준편차 정규화 (SVGF 골격)</td><td>모멘트 동시 누적 + confidence</td><td>다광원 직접광</td></tr>
<tr><td><strong>UE Path Tracer</strong></td><td>플러그인 개방</td><td>플러그인별 (NFOR 회귀 / OIDN CNN)</td><td>엔진 자체 no-velocity temporal</td><td>오프라인/MRQ</td></tr>
</table>
</div>

<span class="section-eyebrow">12 — 마치며</span>
</div>

# 마치며: 세 가지 질문으로 요약되는 10년

<div class="dn-post">
<p style="color:var(--text2);line-height:1.85;">
이 흐름은 결국 세 가지 설계 질문으로 압축된다. <strong>첫째, 필터를 얼마나 세게 걸지 무엇으로 판단할 것인가.</strong> SVGF·ReLAX·FidelityFX는 노이즈의 통계량(분산)을 추정해서 정하고, ReBLUR는 누적 프레임 수로, UE SSD는 hit distance의 기하로 정한다 — 추정이 정확하면 통계 쪽이 이상적이지만, 1 spp에서 추정 자체가 노이즈이기 때문에 "추정하지 않고 아는 값으로 대신한다"는 우회로가 실전에서 강하다. <strong>둘째, 디노이저를 어디에 둘 것인가.</strong> 파이프라인 끝의 범용 후처리로 둘 수도 있고(SSD, NRD), Lumen처럼 배치·조준·필터·보간의 매 단계에 노이즈 예산을 분산시켜 "디노이저"라 부를 만한 덩어리 자체를 없앨 수도 있다. <strong>셋째, 사람이 설계할 것인가 학습시킬 것인가.</strong> Ray Reconstruction의 등장으로 이 질문은 더 이상 오프라인만의 것이 아니게 됐고, UE가 NNE로 ONNX 디노이저를 엔진 추론 스택에 올린 것도 같은 흐름이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그리고 하나의 공통 전제 — 어떤 디노이저든 시간축 재사용 없이는 성립하지 않는다. 이 글이 "재투영해서 누적한다"고 한 줄로 지나간 그 단계에는 히스토리를 언제 믿고 언제 버릴지에 대한 또 하나의 세계가 있다. <a href="/tsr">TSR 글</a>에서 컬러 히스토리에 대해 다뤘던 그 질문을 엔진 전체 시스템으로 넓혀 보는 것은 별도의 글감으로 남겨 둔다.
</p>

<div class="callout callout-info">
<div class="callout-title">참고 자료</div>
<p>Schied et al., <em>Spatiotemporal Variance-Guided Filtering</em>, HPG 2017 · Schied et al., <em>Gradient Estimation for Real-Time Adaptive Temporal Filtering</em> (A-SVGF), HPG 2018 · Zhdan, <em>Fast Denoising with Self-Stabilizing Recurrent Blurs</em>, GTC 2020 · <em>ReBLUR: A Hierarchical Recurrent Denoiser</em>, Ray Tracing Gems II ch.49 · NVIDIA-RTX/NRD GitHub README · AMD GPUOpen FidelityFX Denoiser 문서 · Ouyang et al., <em>ReSTIR GI</em>, 2021 · NVIDIA DLSS 3.5 Ray Reconstruction 발표 · Intel Open Image Denoise GitHub · UE 5.8 소스: <code>ScreenSpaceDenoise.cpp/.h</code>, <code>SSD*.usf/.ush</code>, <code>LumenScreenProbeGather/Filtering/ImportanceSampling.*</code>, <code>LumenReflections.cpp</code>, <code>MegaLights.cpp</code>, <code>MegaLightsDenoising.cpp</code>, <code>MegaLightsDenoiserSpatial.usf</code>, <code>PathTracingDenoiser.h</code>, <code>PathTracingSpatialTemporalDenoising.cpp</code>, <code>NFORDenoise</code>/<code>OpenImageDenoise</code>/<code>OptiXDenoise</code>/<code>NNEDenoiser</code> 플러그인. 성능 수치(SVGF 10ms, A-SVGF 2ms)는 발표 당시 하드웨어(TITAN X Pascal / Titan Xp) 기준임에 유의.</p>
</div>
</div>
