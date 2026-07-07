---
layout: post
title: "UE5 MegaLights: 수천 개의 그림자 라이트를 고정 비용으로"
icon: paper
permalink: megalights
categories: Rendering
tags: [ComputerGraphics, Rendering, UnrealEngine, MegaLights, Lighting, Shadow, RayTracing]
excerpt: "MegaLights"
back_color: "#ffffff"
img_name: "megalights.webp"
toc: false
show: true
new: true
series: -1
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - "그림자 켠 라이트를 수백 개 깔면 왜 프레임이 무너지지?"가 궁금한 분
> - MegaLights가 라이트 개수와 무관하게 고정 비용을 내는 원리를 알고 싶은 분
> - Spot / Point / Rect / Directional 라이트가 각각 어떻게 처리되는지 궁금한 분
> - 기존 Shadow Map 방식과 MegaLights의 Ray Traced Shadow가 어떻게 다른지 이해하고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - Deferred Lighting이 라이트 수에 따라 비용이 선형으로 늘어나는 구조적 이유
> - "픽셀당 고정된 개수의 광선만 쏜다"는 Stochastic Direct Lighting의 발상
> - Weighted Reservoir Sampling으로 라이트를 고르는 방법과 <code>log2(Luminance)</code> 가중치
> - Visible Light List(이전 프레임 가시 라이트 목록)로 샘플을 유도하는 방식
> - Local / Rect / Area / Directional 라이트별 처리와 관련 CVar
> - Ray Traced Shadow(Near/Far Field, Screen Trace)와 VSM Fallback의 역할 분담
> - 1spp 노이즈를 정리하는 Temporal + Spatial 디노이저

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.ml-post {
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
.ml-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.ml-post .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.ml-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.ml-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.ml-post .card.blue::before   { background: var(--accent); }
.ml-post .card.gold::before   { background: var(--gold); }
.ml-post .card.teal::before   { background: var(--teal); }
.ml-post .card.coral::before  { background: var(--coral); }
.ml-post .card.purple::before { background: var(--accent2); }
.ml-post .card.orange::before { background: var(--orange); }
.ml-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.ml-post .card.blue   .card-label { color: var(--accent); }
.ml-post .card.gold   .card-label { color: var(--gold); }
.ml-post .card.teal   .card-label { color: var(--teal); }
.ml-post .card.coral  .card-label { color: var(--coral); }
.ml-post .card.purple .card-label { color: var(--accent2); }
.ml-post .card.orange .card-label { color: var(--orange); }
.ml-post .card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.ml-post .card-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.ml-post .callout {
  border-radius: 12px;
  padding: 16px 20px;
  margin: 20px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.ml-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.ml-post .callout-info { background: rgba(61,99,224,0.05); border-color: rgba(61,99,224,0.18); }
.ml-post .callout-info::before { background: var(--accent); }
.ml-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.ml-post .callout-warn::before { background: var(--gold); }
.ml-post .callout-teal { background: rgba(10,143,98,0.05); border-color: rgba(10,143,98,0.20); }
.ml-post .callout-teal::before { background: var(--teal); }
.ml-post .callout-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.ml-post .callout-info .callout-title { color: var(--accent); }
.ml-post .callout-warn .callout-title { color: var(--gold); }
.ml-post .callout-teal .callout-title { color: var(--teal); }
.ml-post .callout p { margin: 0; font-size: 13px; color: var(--text2); line-height: 1.75; }
.ml-post .code-block {
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
.ml-post .code-block .kw  { color: #a78bfa; }
.ml-post .code-block .fn  { color: #34d399; }
.ml-post .code-block .cm  { color: #525a78; font-style: italic; }
.ml-post .code-block .num { color: #fb923c; }
.ml-post .code-block .str { color: #fbbf24; }
.ml-post .code-block .ty  { color: #38bdf8; }
.ml-post .code-lang {
  position: absolute;
  top: 10px; right: 14px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #525a78;
}
.ml-post .flow-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 24px 0;
  overflow-x: auto;
}
.ml-post .flow-step {
  flex: 1;
  min-width: 120px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 14px 16px;
  position: relative;
  text-align: center;
}
.ml-post .flow-step .step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 4px;
}
.ml-post .flow-step .step-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.ml-post .flow-step .step-desc {
  font-size: 11px;
  color: var(--text2);
  line-height: 1.5;
}
.ml-post .flow-arrow {
  display: flex;
  align-items: center;
  padding: 0 6px;
  color: var(--text3);
  font-size: 18px;
  flex-shrink: 0;
}
.ml-post .step-block {
  border-left: 3px solid var(--border2);
  padding: 16px 20px;
  margin: 16px 0;
  background: var(--surface);
  border-radius: 0 10px 10px 0;
}
.ml-post .step-block.s1 { border-color: var(--coral); }
.ml-post .step-block.s2 { border-color: var(--gold); }
.ml-post .step-block.s3 { border-color: var(--teal); }
.ml-post .step-block.s4 { border-color: var(--accent); }
.ml-post .step-block h4 {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 6px;
}
.ml-post .step-block.s1 h4 { color: var(--coral); }
.ml-post .step-block.s2 h4 { color: var(--gold); }
.ml-post .step-block.s3 h4 { color: var(--teal); }
.ml-post .step-block.s4 h4 { color: var(--accent); }
.ml-post .step-block p {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.75;
  margin: 0 0 8px 0;
}
.ml-post .step-block p:last-child { margin-bottom: 0; }
.ml-post .flag-badge {
  display: inline-block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 5px;
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.ml-post .flag-coral  { background: rgba(214,48,49,0.12);  color: var(--coral); }
.ml-post .flag-blue   { background: rgba(61,99,224,0.12);  color: var(--accent); }
.ml-post .flag-teal   { background: rgba(10,143,98,0.12);  color: var(--teal); }
.ml-post .flag-gold   { background: rgba(176,125,0,0.12);  color: var(--gold); }
.ml-post .flag-purple { background: rgba(114,72,212,0.12); color: var(--accent2); }
.ml-post .flag-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 14px; }
.ml-post .data-table { overflow-x: auto; margin: 24px 0; }
.ml-post .data-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ml-post .data-table th {
  padding: 10px 14px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--accent);
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
}
.ml-post .data-table td { padding: 9px 14px; border: 1px solid var(--border); color: var(--text2); }
.ml-post .data-table tr:nth-child(even) td { background: var(--surface); }
.ml-post .data-table code { font-size: 12px; }
</style>

<div class="ml-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# MegaLights 개요

<div class="ml-post">
<p style="color:var(--text2);line-height:1.85;">
MegaLights는 UE 5.5에서 실험적으로 공개된 <strong>Stochastic Direct Lighting</strong> 기술이다. 한 줄로 요약하면 <strong>"수백~수천 개의 그림자 라이트를, 라이트 개수와 거의 무관한 고정 비용으로 그리는 것"</strong>이다. 비결은 단순하다. 모든 라이트를 일일이 계산하는 대신, <strong>픽셀마다 고정된 개수(보통 1~4개)의 광선만 확률적으로 선택한 라이트로 쏘고</strong>, 그 결과를 디노이징해서 복원한다. SIGGRAPH 2025 Advances 강연에서 Epic은 PS5·1080p·1spp에서 <strong>화면에 941개의 면광원(area light)이 모두 그림자를 드리우는 장면을 직접 라이팅 전체 5.51ms</strong>에 그려냈다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>이 글은 UE5 소스(<code>Engine/Source/Runtime/Renderer/Private/MegaLights/</code>, <code>Engine/Shaders/Private/MegaLights/</code>)와 Epic의 SIGGRAPH 2025 Advances 강연 <em>"MegaLights: Stochastic Direct Lighting in Unreal Engine 5"</em>(Narkowicz &amp; Costa)를 함께 따라가며 정리했다. 셰이더는 코드를 직접 인용하고, 설계 의도는 강연 내용을 근거로 한다.</p>
</div>

<span class="section-eyebrow">01 — 배경</span>
</div>

# 배경: 왜 기존 방식은 무너지는가

<div class="ml-post">
<p style="color:var(--text2);line-height:1.85;">
게임은 끊임없이 라이트를 더 많이, 더 동적으로, 모두 그림자를 드리우게 쓰고 싶어 한다. 면광원의 부드러운 그림자, 복잡한 BRDF, 레이어드 머티리얼까지. 이 욕심을 푸는 직접광 접근법은 크게 세 가지다. 아래 <strong>기존 방식 1·2는 게임에서 쓰던 방법</strong>으로 각자 한계가 뚜렷하고, <strong>새로운 방식은 그 한계를 피하려고 MegaLights가 택한 길(해답)</strong>이다. 즉 셋은 "무너지는 이유"가 아니라 "직접광을 푸는 세 갈래"이며, 기존 둘이 무너지는 지점에서 새로운 방식이 출발한다.
</p>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));">
<div class="card coral">
<div class="card-label">기존 방식 1</div>
<div class="card-title">Deferred Lighting — 라이트당 일을 한다</div>
<div class="card-desc">라이트마다 먼저 그림자 항(Shadow Map 또는 Ray Traced Shadow + 디노이즈)을 만들고, 별도 패스에서 라이트를 하나씩 적용한다. 라이트가 적으면 훌륭하지만, <strong>비용이 라이트 개수에 비례</strong>해 늘어난다.</div>
</div>
<div class="card gold">
<div class="card-label">기존 방식 2</div>
<div class="card-title">BRDF Sampling — GI 문제로 떠넘기기</div>
<div class="card-desc">진짜 면광원(특히 Rect)은 <strong>부드러운 그림자가 shadow map 한 번 조회로 안 나와 여러 샘플이 필요해 비쌌다</strong>(면광원 셰이딩도 무겁다). 그 비용을 피하려 에미시브 메시를 숨겨 <strong>Lumen GI가 줍게 한</strong> UE5의 흔한 우회법. 거의 공짜지만 작거나 먼 광원을 BRDF 샘플링으로 찾기 어렵고, 실시간 GI에 직접광까지 떠넘기게 된다.</div>
</div>
</div>

<div style="text-align:center;color:var(--text3);font-size:13px;font-weight:600;margin:12px 0 8px;">↓ &nbsp;기존 두 방식의 한계를 피해 MegaLights가 택한 길&nbsp; ↓</div>

<div class="card teal" style="margin-bottom:8px;">
<div class="card-label">새로운 방식 ★</div>
<div class="card-title">Light Sampling — 고정 개수 광선 <span style="font-weight:600;color:var(--teal);">(MegaLights)</span></div>
<div class="card-desc">오프라인 렌더링에서 흔한 방식. <strong>픽셀당 고정된 개수의 광선</strong>을 확률적으로 고른 라이트로 쏘고, 맞으면 에너지를 누적한다. <strong>성능이 라이트 복잡도와 무관</strong>해진다 — 이것이 MegaLights가 택한 길이며, 02장에서 자세히 본다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
강연에서 Epic이 든 핵심 예시가 직관을 정확히 찌른다. 어떤 픽셀이 <strong>50개 라이트의 감쇠 범위 안</strong>에 들어 있다. Deferred라면 50개 모두에 대해 그림자를 계산해야 한다. 그런데 실제로 그 픽셀에 영향을 주는 건 <strong>15개뿐</strong>이고, 더 결정적으로 <strong>그 픽셀이 받는 에너지의 80%가 단 하나의 라이트</strong>에서 온다. 나머지 49개에 쏟은 일은 거의 낭비다.
</p>

<div class="data-table">
<table>
<thead><tr><th>한계</th><th>구체적 증상 (강연 기준)</th></tr></thead>
<tbody>
<tr><td>Shadow Map 캐싱</td><td>라이트·카메라·오브젝트가 움직이면 캐시가 깨진다. MegaLights 데모처럼 봇이 날아다니며 <strong>수백 개의 움직이는 라이트</strong>를 만들면 캐싱 자체가 무력화된다.</td></tr>
<tr><td>Virtual Shadow Map 메모리</td><td>같은 데모에서 VSM을 켜면 <strong>가상 페이지 캐시의 최대 할당 4GB를 가득 채우고도</strong> 모든 라이트를 못 담아 아티팩트가 생긴다.</td></tr>
<tr><td>Ray Traced Shadow (라이트당)</td><td>적응적 트레이싱·희소 마스크로 비용을 일부 숨길 수 있지만 <strong>전체 스케일링은 거의 그대로</strong>. 라이트당 Ray Tracing+디노이즈는 라이트 수에 강한 상한을 건다.</td></tr>
<tr><td>그림자가 공짜라 해도</td><td>15개라도 <strong>복잡한 광원 타입 + 복잡한 머티리얼</strong>이면 unshadowed 평가만으로도 콘솔에선 너무 비싸다.</td></tr>
</tbody>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
결론은 하나다. <strong>"왜 50개를 무차별로 다 계산하나? 가장 중요한 하나를 고품질로 계산하고 나머지는 근사하면 되지 않나?"</strong> 이 질문이 MegaLights의 출발점이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
정리하면 기존 Deferred와 MegaLights가 택한 <strong>Stochastic Direct Lighting</strong>은 라이트를 다루는 방식 자체가 다르다. 핵심은 "전부 결정론적으로 계산"에서 "소수를 확률적으로 추정"으로 바뀐 것이다.
</p>

<div class="data-table">
<table>
<thead><tr><th>구분</th><th>기존 Deferred</th><th>Stochastic Direct Lighting</th></tr></thead>
<tbody>
<tr><td>라이트 평가</td><td>영향 주는 라이트를 <strong>전부</strong> 계산 (결정론적)</td><td>가중치에 비례해 <strong>랜덤하게 소수만</strong> 뽑음</td></tr>
<tr><td>그림자</td><td>라이트마다 그림자 항을 따로 계산</td><td><strong>랜덤 방향의 광선</strong> 몇 발로 추정</td></tr>
<tr><td>면광원</td><td>해석적 적분 (예: LTC)</td><td>광원 표면 위 <strong>랜덤한 점</strong> 선택</td></tr>
<tr><td>성격</td><td>정확하지만 <strong>라이트 수에 비용 비례</strong></td><td><strong>몬테카를로 추정</strong> — 고정 비용, 대신 노이즈</td></tr>
<tr><td>노이즈</td><td>없음</td><td>있음 → <strong>디노이즈 필요</strong></td></tr>
</tbody>
</table>
</div>

<span class="section-eyebrow">02 — 핵심 아이디어</span>
</div>

# 핵심 아이디어: 고정 개수의 광선

<div class="ml-post">
<p style="color:var(--text2);line-height:1.85;">
MegaLights의 런타임은 매 프레임 아래 다섯 단계를 돈다. 핵심은 <strong>Tracing(Ray Tracing) 단계가 라이트 개수가 아니라 "픽셀당 샘플 수"에만 비례</strong>한다는 점이다. 씬에 라이트가 100개든 10,000개든, 픽셀이 쏘는 광선 수는 동일하다.
</p>

<div class="flow-row">
<div class="flow-step">
<div class="step-num">Step 1</div>
<div class="step-name">Sampling</div>
<div class="step-desc">픽셀당 N개의 라이트 샘플을 확률적으로 선택</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">Step 2</div>
<div class="step-name">Tracing</div>
<div class="step-desc">선택된 샘플로 가시성(그림자) Ray Tracing</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">Step 3</div>
<div class="step-name">Shading</div>
<div class="step-desc">보이는 샘플에 대해서만 BRDF 평가·누적</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">Step 4</div>
<div class="step-name">Visibility</div>
<div class="step-desc">8×8 타일별 Visible Light List 구축 (다음 프레임용)</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">Step 5</div>
<div class="step-name">Denoising</div>
<div class="step-desc">모든 라이트를 한 번에 디노이즈</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
모든 그림자가 <strong>Ray Tracing 하나로 통합 처리</strong>된다는 점이 중요하다. 라이트마다 Shadow Map을 만들고 디노이즈하던 일이 사라지고, 대신 픽셀당 소수의 가시성 광선으로 대체된다. 그렇다면 핵심 난제는 <strong>"적은 광선으로 어떤 라이트를 고를 것인가(Light Selection)"</strong>로 옮겨간다. 콘솔에서는 픽셀당 광선이 사실상 <strong>1개(≈0.8spp)</strong>뿐이라, 이 한 발을 어디로 쏘느냐가 화질을 좌우한다.
</p>

<div class="callout callout-warn">
<div class="callout-title">그럼 ReSTIR를 쓰면 되지 않나?</div>
<p>ReSTIR(Reservoir-based Spatio-Temporal Importance Resampling)는 하이엔드 PC에서 굉장한 결과를 낸다. 하지만 Epic은 콘솔 기준선으로는 부적합하다고 판단했다. ① 히스토리·이웃 reservoir의 <strong>가시성을 다시 광선으로 검증</strong>해야 해서 1spp를 원해도 픽셀당 2~3 트레이스가 필요하다. ② reservoir 재사용은 <strong>같은 샘플을 반복(correlation)</strong>시키는데, 디노이저는 프레임마다 다른 라이트가 번갈아 나오는 비상관 패턴을 좋아한다. 즉 ReSTIR의 화질 개선과 디노이저의 효과가 서로 상쇄된다. <strong>그래서 MegaLights는 reservoir 재사용 대신, 애초에 디노이저 친화적으로 샘플링을 설계</strong>하는 길을 택했다.</p>
</div>

<span class="section-eyebrow">03 — 라이트 선택</span>
</div>

# 라이트 선택: Weighted Reservoir Sampling

<div class="ml-post">
<div class="flag-row"><span class="flag-badge flag-teal">GenerateLightSamplesCS</span><span class="flag-badge flag-purple">MegaLightsSampling.usf / .ush</span></div>

<p style="color:var(--text2);line-height:1.85;">
픽셀당 N개의 라이트를 고르는 데 MegaLights는 <strong>Weighted Reservoir Sampling(WRS)</strong>을 쓴다. 라이트 리스트를 <strong>딱 한 번만 순회</strong>하면서, 각 라이트를 가중치에 비례하는 확률로 reservoir에 채택하는 스트리밍 알고리즘이다. 핵심이 이 함수 하나에 담겨 있다.
</p>

<div class="code-block"><div class="code-lang">HLSL — MegaLightsSampling.ush:84</div><span class="kw">void</span> <span class="fn">AddLightSample</span>(<span class="kw">inout</span> FLightSampler LightSampler, <span class="kw">float</span> SampleWeight,
                   <span class="kw">uint</span> ForwardLightIndex, <span class="kw">bool</span> bWasVisibleInLastFrame, <span class="kw">bool</span> bRadialLight)
{
    <span class="cm">// Directional 라이트가 샘플 예산을 독식하지 못하게 가중치 상한</span>
    <span class="kw">if</span> (!bRadialLight &amp;&amp; DirectionalLightSampleRatio &gt; <span class="num">0.0f</span>)
        SampleWeight = <span class="fn">min</span>(SampleWeight, <span class="fn">max</span>(LightSampler.WeightSum, MinSampleClampingWeight) * DirectionalLightSampleRatio);

    <span class="kw">float</span> Tau = LightSampler.WeightSum / (LightSampler.WeightSum + SampleWeight);
    LightSampler.WeightSum += SampleWeight;

    <span class="kw">for</span> (<span class="kw">uint</span> i = <span class="num">0</span>; i &lt; NUM_SAMPLES_1D; ++i)
    {
        <span class="kw">if</span> (LightSampler.LightIndexRandom[i] &lt; Tau)
            LightSampler.LightIndexRandom[i] /= Tau;          <span class="cm">// 기존 샘플 유지</span>
        <span class="kw">else</span> {
            <span class="cm">// 이 라이트를 채택 — 난수를 [0,1)로 다시 펼쳐 재사용</span>
            LightSampler.LightIndexRandom[i] = (LightSampler.LightIndexRandom[i] - Tau) / (<span class="num">1.0f</span> - Tau);
            FCandidateLightSample s = <span class="fn">InitCandidateLightSample</span>();
            s.LocalLightIndex = ForwardLightIndex; s.Weight = SampleWeight;
            s.bLightWasVisible = bWasVisibleInLastFrame;
            LightSampler.PackedSamples[i] = <span class="fn">PackCandidateLightSample</span>(s);
        }
    }
}</div>

<p style="color:var(--text2);line-height:1.85;">
이때 <strong>각 라이트의 가중치는 무엇인가?</strong> "그림자를 무시한" 상태에서 그 라이트가 픽셀에 줄 <strong>밝기(BRDF × 라이트)의 휘도</strong>다. 단, 그대로 쓰지 않고 <code>log2(휘도 + 1)</code>로 변환한다. 톤매핑 후 화면에 미치는 실제 영향에 맞춘 <strong>지각적(perceptual) 가중치</strong>로, 너무 강한 라이트가 샘플을 독식하는 문제를 눌러준다.
</p>

<div class="code-block"><div class="code-lang">HLSL — MegaLightsSampling.usf:101 · 110 (GetLocalLightTargetPDF)</div><span class="cm">// 그림자를 끈 상태의 분리 라이팅(diffuse+spec)에서 휘도만 추출</span>
<span class="kw">float</span> Lum = SplitLighting.LightingLuminance * View.PreExposure;
<span class="cm">// IES 프로파일이 있으면 곱해줌</span>
<span class="kw">if</span> (LightData.IESAtlasIndex &gt;= <span class="num">0</span> &amp;&amp; Lum &gt; <span class="num">0.01f</span>)
    Lum *= <span class="fn">ComputeLightProfileMultiplier</span>(...);
<span class="cm">// 지각적 가중치: log2로 강한 라이트를 완만하게</span>
LightTargetPDF.Weight = <span class="fn">log2</span>(Lum + <span class="num">1.0f</span>);</div>

<p style="color:var(--text2);line-height:1.85;">
난수는 일반 난수가 아니라 <strong>Spatio-Temporal Blue Noise(STBN)</strong>를 쓴다. 디노이저에 최적화된 패턴이라 같은 샘플 수로도 훨씬 깨끗하게 복원된다. 다만 STBN 텍스처는 "픽셀당 한 번 샘플링"하도록 만들어져 있어, 라이트 선택 루프처럼 여러 난수가 필요할 때는 <strong>Sample Warping(선택 후 구간을 [0,1)로 다시 펼침)</strong>과 <strong>Dithered Sampling</strong>으로 한 텍스처 룩업을 쪼개 재사용한다. 위 코드의 <code>난수 /= Tau</code>, <code>(난수 - Tau)/(1-Tau)</code>가 바로 그 Warping이다.
</p>

<h2>"보이는 라이트"만 고른다 — Visible Light List</h2>

<p style="color:var(--text2);line-height:1.85;">
1spp에서 가장 뼈아픈 낭비는 <strong>가려진 라이트로 광선을 쏘는 것</strong>이다. 그 한 발이 occlusion으로 사라지면 그 픽셀은 그 프레임에 아무것도 못 얻는다. MegaLights의 해법은 <strong>이전 프레임에 실제로 보였던 라이트 목록</strong>을 활용하는 것이다. "지난 프레임에 보였으면 이번 프레임에도 보일 확률이 높다"는 가정이다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">구축</div>
<div class="card-title">8×8 타일당 가시 목록</div>
<div class="card-desc">Tracing 후, 보였던 라이트 샘플을 모아 <code>WaveActiveMin</code>으로 정렬된 목록을 <strong>8×8 화면 타일마다</strong> 만든다. 픽셀당 목록은 메모리가 너무 커서, 이웃이 가시성을 공유한다는 점을 이용해 타일 단위로 압축한다.</div>
</div>
<div class="card teal">
<div class="card-label">조회</div>
<div class="card-title">Stochastic Bilinear Lookup</div>
<div class="card-desc">다음 프레임 Sampling에서 픽셀을 리프로젝션해 해당 타일 목록을 읽는다. 타일 경계의 불연속을 숨기려 <strong>가장 가까운 4개 목록을 확률적 bilinear로 보간</strong>한다.</div>
</div>
<div class="card gold">
<div class="card-label">탐색</div>
<div class="card-title">Hidden Light 20% 예산</div>
<div class="card-desc">씬은 동적이라 숨은 라이트가 새로 보일 수 있다. 그래서 <strong>샘플의 일부(약 20%)는 가시 목록에 없는 라이트</strong>에 할당한다. 강한 가려진 라이트가 샘플링을 지배하지 못하게 막는 효과도 있다.</div>
</div>
</div>

<div class="callout callout-teal">
<div class="callout-title">구현 — 두 개의 reservoir</div>
<p>위 "가시 목록"과 "Hidden 20%"는 실제로 <strong>reservoir(당첨 샘플을 담는 통 — 앞의 WRS 참고)를 두 개</strong> 두어 구현한다. <strong>Visible Light Reservoir</strong>는 이전 프레임에 보였던 라이트(가시 목록)로, <strong>Hidden Light Reservoir</strong>는 목록에 없는 숨은 라이트로, 각각 <strong>독립된 난수</strong>로 채운다. 그리고 <strong>합치기 직전에 숨은 쪽 weight sum을 가시 쪽의 약 20%로 clamp</strong>한다 → 숨은 라이트가 가져갈 수 있는 샘플 비율에 상한이 생겨, 아무리 강한 가려진 라이트라도 샘플링을 독식하지 못한다. 반대로 가시 광이 약하거나 아예 없으면 clamp를 풀어 더 많은 샘플을 숨은 쪽에 주고, 히스토리 리프로젝션이 실패하면(빠른 이동·화면 밖) 숨은 비율을 <strong>최대 50%까지</strong> 올려 새 라이트를 빨리 찾는다. 즉 "당첨자 통"을 용도별로 둘 두고 비율을 조절해 합치는 구조다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
코드에서 실제 라이트 순회는 <code>GenerateLightSamplesCS</code> 안에 있다. <strong>Forward Light Grid의 셀</strong>(클러스터드 라이트 컬링 결과)을 돌면서 각 라이트를 <code>SampleLight</code>→<code>AddLightSample</code>로 reservoir에 넣고, 그다음 Directional 라이트를 따로 순회한다. 셀 안 라이트가 수백 개일 수 있어, <strong>가시 목록에 있는 라이트는 모두 보고 + 라이트 그리드는 N개 간격으로 건너뛰며(stride)</strong> 평가한다(히스토리 미스면 N을 늘림).
</p>

<div class="code-block"><div class="code-lang">HLSL — MegaLightsSampling.usf:436 · 472 (요지)</div><span class="cm">// 1) 이 픽셀의 라이트 그리드 셀에 속한 Local 라이트들을 순회</span>
<span class="kw">while</span> (GridLightIndex &lt; NumLightsInGridCell) {
    <span class="kw">uint</span> LocalLightIndex = <span class="fn">GetCulledLightDataGrid</span>(... + GridLightIndex);
    ++GridLightIndex;
    <span class="fn">SampleLight</span>(ScreenCoord, TranslatedWorldPosition, Material, ...,
                LocalLightIndex, LightSampler, DebugContext);  <span class="cm">// → AddLightSample</span>
}
<span class="cm">// 2) Directional 라이트는 별도 루프 (MegaLights 지원 시작 인덱스부터)</span>
<span class="kw">for</span> (<span class="kw">uint</span> i = ForwardLightStruct.DirectionalMegaLightsSupportedStartIndex;
     i &lt; ForwardLightStruct.NumDirectionalLights; ++i)
    <span class="fn">SampleDirectionalLight</span>(i, ScreenCoord, ..., LightSampler, DebugContext);</div>

<div class="callout callout-info">
<div class="callout-title">Downsampled Sampling — 4배 빠르게</div>
<p>이웃 픽셀은 노멀·깊이가 비슷하면 라이트 가중치도 비슷하다. 그래서 <code>r.MegaLights.DownsampleMode</code> 기본값은 <strong>2(2×2 half-res)</strong>로, 4픽셀마다 4샘플을 뽑아 BRDF 계산을 공유한다. 이후 깊이·노멀 가중 <strong>Stochastic Bilinear Upsample</strong>로 풀 해상도로 복원한다. 그림자가 살짝 부드러워지는 대신 샘플링이 거의 4배 빨라지는 트레이드오프다.</p>
</div>

<span class="section-eyebrow">04 — 라이트 타입</span>
</div>

# Spot · Point · Rect · Directional, 다 되나?

<div class="ml-post">
<p style="color:var(--text2);line-height:1.85;">
결론부터: <strong>Local 라이트(Point/Spot/Rect)는 기본으로 완전 지원되고, Directional은 지원하되 기본 비활성(opt-in)이며, Rect/Textured/IES/Light Function까지 모두 처리</strong>된다. 하나씩 코드로 보자.
</p>

<div class="step-block s3">
<h4>Point / Spot — Radial Light (기본 경로)</h4>
<p>Point와 Spot은 코드에서 <strong>"Radial Light"</strong>로 묶여 Forward Light Grid를 통해 들어온다. 위 <code>GenerateLightSamplesCS</code>의 그리드 셀 순회가 곧 이들의 처리 경로다. Spot의 콘 감쇠, Point의 역제곱 감쇠는 <code>GetLocalLightTargetPDF</code>가 호출하는 <code>GetMegaLightsSplitLighting</code>에서 일반 Deferred 라이팅과 동일하게 평가된다. 라이트 인덱스는 <code>MAX_LOCAL_LIGHT_NUM = 65536</code>(<code>MegaLightsDefinitions.h:29</code>)까지 패킹된다.</p>
</div>

<div class="step-block s4">
<h4>Rect / Textured Rect — 전용 타일 퍼뮤테이션</h4>
<p>면광원인 Rect 라이트, 그리고 소스 텍스처가 달린 Textured Rect는 register 압박이 크다. 그래서 <strong>타일 분류(Tile Classification)에서 Rect·Textured 여부를 분리</strong>해 전용 셰이더 퍼뮤테이션으로 디스패치한다(강연 기준 occupancy 약 20% 향상). 타일 타입은 <code>SimpleShading_Rect</code>, <code>ComplexShading_Rect_Textured</code> 등으로 나뉜다(<code>MegaLightsDefinitions.h</code>). 라이트 그리드 컬링 단계에서도 <strong>Rect의 barn door(가림막)를 반영</strong>해 영향 셀을 크게 줄인다.</p>
</div>

<div class="step-block s2">
<h4>Area Light — 2×2 가시성 비트마스크</h4>
<p>큰 면광원은 "보인다/안 보인다" 이진 판정으로 부족하다. 절반이 가려졌으면 그쪽으로 쏜 광선은 낭비다. MegaLights는 Visible Light List의 <strong>페이로드로 라이트당 2×2 비트마스크</strong>를 들고 다니며, 광원 표면의 어느 사분면이 보였는지 기록한다. 샘플링 시 area light의 2D 난수를 이 마스크로 warping해 <strong>보이는 부분으로 점을 더 많이</strong> 찍는다. 코드의 <code>AreaLightHiddenPDFWeight</code>, <code>GetLightVisibilityMask</code>, UV warping 블록(<code>MegaLightsSampling.usf:529~</code>)이 이 처리다.</p>
</div>

<div class="step-block s1">
<h4>Directional Light — 강력해서 위험한 손님</h4>
<p>Directional(태양)은 보통 다른 라이트보다 <strong>수천 배 강하다</strong>. BRDF 기준으로 가중치를 매기면 거의 모든 광선을 태양이 가져가, 실내처럼 태양이 안 보이는 곳에서도 local 라이트를 못 찾는 문제가 생긴다. MegaLights는 별도 패스(비쌈) 대신, <strong>Directional이 쓸 수 있는 샘플 비율을 local 가중치 합의 일정 비율(기본 약 50%)로 제한</strong>한다. 이것이 03장 <code>AddLightSample</code> 맨 위의 <code>DirectionalLightSampleRatio</code> 클램프다. local이 약하거나 없으면(<code>max(WeightSum, MinClamp)</code>) 자동으로 더 많은 샘플을 태양에 양보한다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
어떤 라이트를 MegaLights로 처리할지는 C++의 <code>GetMegaLightsMode</code>가 결정한다. 여기서 <strong>Directional은 CVar로 게이팅</strong>된다는 점이 보인다.
</p>

<div class="code-block"><div class="code-lang">C++ — MegaLights.cpp:556 (GetMegaLightsMode)</div>EMegaLightsMode <span class="fn">GetMegaLightsMode</span>(..., uint8 LightType, bool bLightAllowsMegaLights, ... ShadowMethod)
{
    <span class="cm">// Directional은 r.MegaLights.DirectionalLights(기본 0)가 켜져야 처리</span>
    <span class="kw">if</span> ((LightType != LightType_Directional || CVarMegaLightsDirectionalLights.<span class="fn">GetValueOnRenderThread</span>())
        &amp;&amp; <span class="fn">IsEnabled</span>(ViewFamily) &amp;&amp; bLightAllowsMegaLights)
    {
        <span class="cm">// 라이트별 ShadowMethod → VSM이면 EnabledVSM, 아니면 RT</span>
        <span class="kw">if</span> (bUseVSM)                                   <span class="kw">return</span> EMegaLightsMode::EnabledVSM;
        <span class="kw">else if</span> (View.<span class="fn">IsRayTracingAllowedForView</span>())   <span class="kw">return</span> EMegaLightsMode::EnabledRT;
    }
    <span class="kw">return</span> EMegaLightsMode::Disabled; <span class="cm">// 이 라이트는 레거시 경로로</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
즉 라이트는 <strong>① 라이트 컴포넌트에서 MegaLights 허용 여부(<code>bLightAllowsMegaLights</code>), ② 타입별 게이트(Directional은 CVar), ③ 그림자 방식(RT/VSM)</strong>으로 분기한다. 한 씬에서 일부는 RT 그림자, 일부는 VSM 그림자, 일부는 레거시로 섞을 수 있다. IES 프로파일·Light Function·Lighting Channel도 각각 CVar로 켜고 끈다.
</p>

<div class="data-table">
<table>
<thead><tr><th>CVar</th><th>기본값</th><th>의미</th></tr></thead>
<tbody>
<tr><td><code>r.MegaLights.DirectionalLights</code></td><td>0</td><td>Directional 라이트 지원 (기본 꺼짐 — opt-in)</td></tr>
<tr><td><code>r.MegaLights.NumSamplesPerPixel</code></td><td>4</td><td>픽셀당 샘플 수 (2 / 4 / 16)</td></tr>
<tr><td><code>r.MegaLights.DownsampleMode</code></td><td>2</td><td>0=풀해상도, 1=체커보드, 2=half-res</td></tr>
<tr><td><code>r.MegaLights.TexturedRectLights</code></td><td>1</td><td>텍스처 달린 Rect 라이트 지원</td></tr>
<tr><td><code>r.MegaLights.IESProfiles</code></td><td>1</td><td>IES 프로파일 지원</td></tr>
<tr><td><code>r.MegaLights.LightFunctions</code></td><td>1</td><td>Light Function 지원</td></tr>
<tr><td><code>r.MegaLights.LightingChannels</code></td><td>1</td><td>Lighting Channel로 그림자 차단</td></tr>
<tr><td><code>r.MegaLights.GuideByHistory</code></td><td>2</td><td>0=끔, 1=보이는 라이트로, 2=보이는 부분으로 유도</td></tr>
</tbody>
</table>
</div>

<span class="section-eyebrow">05 — 그림자 처리</span>
</div>

# 그림자: 기존 Shadow Map vs MegaLights

<div class="ml-post">
<p style="color:var(--text2);line-height:1.85;">
기존 방식과 MegaLights의 차이가 가장 선명하게 갈리는 지점이 바로 그림자 처리다. <strong>왜 기존 방식은 라이트 수에 발목 잡히고, MegaLights는 안 잡히는가.</strong>
</p>

<div class="card-grid">
<div class="card coral">
<div class="card-label">기존 방식</div>
<div class="card-title">라이트당 2패스 + 아틀라스</div>
<div class="card-desc">그림자 라이트마다 ① 라이트 시점에서 <strong>Shadow Depth Pass</strong>(씬 지오메트리 재렌더)와 ② 화면 공간 <strong>Shadow Projection Pass</strong>를 돈다. N개 라이트 = N번의 지오메트리 재렌더 + N개 아틀라스 할당. <strong>비용이 라이트 수에 선형</strong>. 이것이 과거 동적 그림자 라이트를 빡빡하게 예산 잡던 이유다.</div>
</div>
<div class="card gold">
<div class="card-label">VSM</div>
<div class="card-title">낭비는 줄였지만 라이트당 비용은 남는다</div>
<div class="card-desc"><a href="virtualshadowmap" style="color:var(--gold);">Virtual Shadow Map</a>은 화면이 요청한 페이지만 래스터화하고 정적 지오메트리는 캐싱해 낭비를 크게 줄였다. 하지만 <strong>여전히 라이트마다 자기 VSM을 갖고 요청 페이지를 래스터화</strong>해야 한다. 라이트당 비용이 0이 아니다.</div>
</div>
<div class="card teal">
<div class="card-label">MegaLights</div>
<div class="card-title">모든 그림자 = Ray Tracing (고정 비용)</div>
<div class="card-desc">BVH 비용은 <strong>한 번만</strong> 내면 되고(어차피 Lumen이 요구) <strong>라이트당 추가 비용이 거의 없다</strong>. 픽셀당 고정 개수의 가시성 광선이 전부다. 그래서 라이트가 늘어도 그림자 비용이 거의 일정하다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 트레이드오프는 <code>r.MegaLights.DefaultShadowMethod</code>의 설명 문구에 그대로 박혀 있다.
</p>

<div class="code-block"><div class="code-lang">C++ — MegaLights.cpp:377 (CVar 도움말)</div><span class="cm">// 0 - Ray Tracing. 선호 방식. "고정된 MegaLights 비용"을 보장하고</span>
<span class="cm">//     정확한 면광원 그림자를 주지만, BVH 표현 품질에 의존.</span>
<span class="cm">// 1 - Virtual Shadow Maps. "상당한 라이트당 비용"이 있지만,</span>
<span class="cm">//     Nanite 지오메트리에서 래스터화로 직접 그림자를 캐스팅 가능.</span>
<span class="kw">int32</span> GMegaLightsDefaultShadowMethod = <span class="num">0</span>; <span class="cm">// 기본 = Ray Tracing</span></div>

<h2>Ray Traced Shadow의 실제 구성</h2>

<div class="flag-row"><span class="flag-badge flag-coral">Screen Trace</span><span class="flag-badge flag-blue">Near Field</span><span class="flag-badge flag-gold">Far Field</span><span class="flag-badge flag-purple">VSM (옵션)</span></div>

<p style="color:var(--text2);line-height:1.85;">
"Ray Tracing"이라고 한 방에 끝나는 게 아니라, <strong>여러 트레이스를 단계적으로</strong> 쌓고 단계마다 <strong>Compaction(16×16 타일 단위로 광선을 모아 coherency 확보)</strong>을 거친다.
</p>

<div class="step-block s1">
<h4>① Screen Trace (항상 먼저)</h4>
<p>RT 프록시 메시는 래스터 지오메트리와 정확히 일치하지 않아, 광선 시작점에서 <strong>잘못된 self-shadowing</strong>이 생긴다. 그래서 먼저 깊이 버퍼에 대고 화면 공간 광선(HZB 트레이싱)을 쏴, 표면에서 충분히 떨어진 지점으로 <strong>월드 트레이스의 시작점을 밀어준다</strong>. 덤으로 BVH에 없는 디테일의 <strong>Contact Shadow</strong>도 얻는다.</p>
</div>

<div class="step-block s4">
<h4>② Near Field — Proxy Mesh (플레이어 반경 ~150m)</h4>
<p>원본보다 폴리곤이 적은 프록시 메시로 BVH를 구성해 추적한다. 대부분의 광선이 여기서 처리된다. 알파 마스크 머티리얼을 만나면 <strong>Any-Hit Shader로 재추적(continuation ray)</strong>해 정확도를 챙긴다. 콘솔에선 <strong>Inline Ray Tracing</strong>이 기본(성능 이점).</p>
</div>

<div class="step-block s3">
<h4>③ Far Field — 병합·단순화 (별도 TLAS)</h4>
<p>Near Field 반경을 벗어난 광선은, 인스턴스를 병합하고 삼각형을 크게 줄인 <strong>별도 TLAS</strong>에 대고 추적한다. BVH 복잡도가 낮아 traversal이 빠르다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
하드웨어 RT가 비현실적인 콘텐츠(애니메이션·알파 마스크 폴리지, 대량 인스턴스)도 있다. 이때를 위한 <strong>VSM Fallback</strong>이 있다.
</p>

<div class="callout callout-teal">
<div class="callout-title">VSM Fallback — 주로 Directional용</div>
<p>특정 라이트를 RT 대신 VSM으로 처리할 수 있다. 이때 MegaLights는 <strong>Sampling 패스에서 자기가 고른 샘플이 실제로 건드리는 페이지만 GPU 주도로 마킹</strong>한다(<code>r.MegaLights.VSM.MarkPages</code>, 기본 1). 보수적으로 모든 페이지를 렌더하는 대신 <strong>실제 필요한 페이지만 래스터화</strong>해 라이트당 VSM 비용을 줄인다. 순서는 <strong>마킹 → VSM 렌더 → 트레이싱</strong>. 다만 VSM은 여전히 라이트당 비용이 있어, 실무에선 <strong>표현 불일치가 더 눈에 띄고 BVH로 먼 거리까지 덮기 비싼 Directional 라이트에 주로</strong> 쓴다. (이름이 VSMRT — Shadow Map Ray Tracing.)</p>
</div>

<span class="section-eyebrow">06 — 디노이징</span>
</div>

# 디노이징: 1spp를 화면으로

<div class="ml-post">
<div class="flag-row"><span class="flag-badge flag-blue">DenoiserTemporal</span><span class="flag-badge flag-teal">DenoiserSpatial</span><span class="flag-badge flag-purple">→ TSR</span></div>

<p style="color:var(--text2);line-height:1.85;">
픽셀당 1샘플은 당연히 노이즈 범벅이다. MegaLights는 <strong>모든 라이트를 합친 결과를 단 한 번의 디노이징 패스로</strong> 정리한다. 라이트별로 따로 디노이즈하지 않는다. Diffuse와 Specular 신호는 분리해서 처리하고, 디노이즈 전에 <strong>albedo·EnvBRDF 같은 비확률적 머티리얼 성분을 demodulate</strong>해(흐려지면 안 되니까) 순수 라이팅만 남긴다. 전체 골격은 SVGF의 <strong>시간적 분산(temporal variance)</strong> 아이디어를 따른다 — 픽셀이 얼마나 노이지한지를 분산으로 추정해, 노이지한 곳만 강하게 공간 필터링한다.
</p>

<div class="step-block s4">
<h4>Temporal Filter — 누적과 모멘트</h4>
<p>히스토리를 리프로젝션해 라이팅과 <strong>1차·2차 모멘트(휘도 분산용)</strong>를 누적한다. 라이팅은 <strong>2×R11G11B10F</strong>(diffuse/specular), 모멘트는 R16G16B16A16F. 32비트로도 충분한 건 <strong>stochastic float quantization</strong> 덕분. 5×5 이웃 클램프 + YCoCg 분산 클리핑으로 ghosting을 줄이고, 새 데이터가 이웃 경계에서 멀수록 히스토리를 빠르게 버린다.</p>
</div>

<div class="step-block s3">
<h4>Spatial Filter — 희소 회전 커널 한 번</h4>
<p>비싼 A-Trous 다중 패스 대신, <strong>픽셀마다 회전시킨 희소 커널 하나</strong>만 쓴다(나머지는 TSR이 정리). 상대 분산이 높은 픽셀에만 적용해 더 빠르고 더 선명하다. SVGF의 edge-stopping(깊이·노멀·분산)을 쓰고, 디스오클루전 직후엔 톤매핑 공간에서 누적해 firefly를 억제한다.</p>
</div>

<div class="callout callout-info">
<div class="callout-title">Shading Confidence — 노이즈를 일부러 TSR에 넘긴다</div>
<p>보통 픽셀당 중요한 라이트는 몇 개뿐이다. <strong>Visible Light List가 알려주는 "가능한 총 에너지" 대비, 이번 프레임에 실제 샘플한 에너지 비율</strong>이 좋은 신뢰도 지표가 된다. 80%를 잡았다면 디노이징을 줄이거나 아예 생략하고 신호를 곧장 TSR로 넘긴다. specular highlight의 ghosting·blur 같은 고질병이 줄고 출력이 선명해진다.</p>
</div>

<span class="section-eyebrow">07 — 볼류메트릭 &amp; 반투명</span>
</div>

# 안개와 반투명도 처리된다

<div class="ml-post">
<p style="color:var(--text2);line-height:1.85;">
불투명 표면뿐 아니라 <strong>Volumetric Fog</strong>(카메라 정렬 froxel 그리드)와 <strong>Translucency Lighting</strong>(카메라 주변 월드 공간 복셀 그리드, 복셀당 2밴드 SH)도 같은 철학으로 처리된다. 둘 다 "Sampling → Tracing → Shading → Visible List" 파이프라인을 복셀 단위로 돈다.
</p>

<p style="color:var(--text2);line-height:1.85;">
다만 두 볼륨을 따로 돌리면 일이 중복된다. 그래서 <strong>Hybrid 방식</strong>으로, 더 촘촘한 froxel 위치 기준으로 <strong>Sampling·Tracing을 공유</strong>하고 Shading만 볼륨별로 2번 돈다(볼륨 구축 시간 약 25% 절약). 또 "에너지의 80%가 한 라이트"라는 불투명용 가정이 반투명엔 안 통하고(샘플링 시 노멀·머티리얼을 모름, 복셀이 큼) 가중치가 더 균일해서, <strong>복셀당 더 많은 샘플</strong>을 셰이딩해야 한다. 볼륨은 <code>r.MegaLights.Volume.*</code>, <code>r.MegaLights.TranslucencyVolume.*</code> CVar로 제어한다.
</p>

<span class="section-eyebrow">08 — 성능과 한계</span>
</div>

# 성능, 그리고 한계

<div class="ml-post">
<div class="callout callout-teal">
<div class="callout-title">강연 측정치 (MegaLights 데모)</div>
<p>PS5 · 1080p 렌더 해상도 · 1spp · async compute 끔 · 화면에 <strong>941개 면광원, 픽셀당 20~80개 라이트, 전부 그림자 캐스팅</strong>. 직접 라이팅의 그림자+셰이딩 <strong>전체를 5.51ms</strong>에 대체. 흥미로운 점: 불투명 <strong>Sampling(0.7ms)이 Shading(0.47ms)보다 비싸다</strong> — Shading은 픽셀당 샘플 수에 상한이 있어 비용이 고정적이지만, Sampling은 라이트 수에 비례하기 때문(특히 Rect 라이트가 많아서).</p>
</div>

<h2>직접 재보기 — 측정 지표와 디버그 뷰</h2>

<p style="color:var(--text2);line-height:1.85;">
위 강연 측정치도 결국 <strong>GPU 프로파일러로 패스별 시간을 찍은 것</strong>이다. 내 씬에서 직접 재보려면 아래 도구를 쓴다. 크게 <strong>① 일반 GPU 프로파일링</strong>과 <strong>② MegaLights 전용 디버그 뷰</strong>로 나뉜다.
</p>

<div class="data-table">
<table>
<thead><tr><th>도구 (콘솔 명령)</th><th>무엇을 보나</th></tr></thead>
<tbody>
<tr><td><code>stat GPU</code></td><td>패스별 GPU 시간을 실시간 표로. MegaLights 패스 묶음(Sampling·Tracing·Shading·Denoising)이 그대로 뜬다 — 전체에서 차지하는 비중을 보는 1차 지표.</td></tr>
<tr><td>GPU Visualizer (<code>ProfileGPU</code> / Ctrl+Shift+,)</td><td>RDG 서브패스별 상세 시간. <strong>강연의 그 표(Sampling / Screen Trace / HW Ray Tracing / Sample Shading / Visible Light List / Denoising)가 바로 여기서 나온 수치</strong>다.</td></tr>
<tr><td><code>stat unit</code></td><td>Frame / Game / Render / GPU 전체 시간 — GPU 바운드인지 큰 그림으로 확인.</td></tr>
<tr><td><code>r.MegaLights.Debug 1</code> · <code>2</code></td><td>커서 픽셀의 <strong>Tracing(1) / Sampling(2)</strong> 디버그. 그 픽셀이 어떤 라이트를 어떤 weight·IES·history로 골랐는지 화면에 출력 (<code>r.MegaLights.Debug.CursorX/Y</code>로 위치 고정, <code>.LightId</code>로 특정 라이트 추적).</td></tr>
<tr><td><code>r.MegaLights.Debug.VisualizeLightLoopIterations 1</code> · <code>2</code></td><td>타일별로 <strong>순회한 라이트 수를 히트맵</strong>(파랑→초록→빨강)으로. 샘플링/셰이딩이 비싼 핫스팟 찾기 (1 = Shading 루프, 2 = Sampling 루프).</td></tr>
<tr><td><code>r.MegaLights.Debug.TileClassification 1</code> · <code>2</code></td><td><strong>타일 분류</strong>(Simple/Complex/Rect/Textured/Empty)를 색으로 시각화. register 압박·occupancy를 떨어뜨리는 무거운 타일 진단용.</td></tr>
<tr><td><code>r.MegaLights.Debug.VisualizeLight 1</code></td><td><code>r.MegaLights.Debug.LightId</code>로 지정한 라이트를 구·선으로 표시 — 레벨에서 특정 라이트를 찾을 때.</td></tr>
</tbody>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
실무 흐름은 보통 이렇다. <code>stat GPU</code>로 MegaLights 비중을 본다 → GPU Visualizer로 어느 서브패스(대개 <strong>Sampling이나 Ray Tracing</strong>)가 비싼지 좁힌다 → <code>VisualizeLightLoopIterations</code>로 "라이트를 너무 많이 순회하는 타일"을, <code>TileClassification</code>으로 "무거운 타일 타입(Rect/Textured)"을 찾는다 → 해당 콘텐츠를 손본다(감쇠 범위·스폿 콘 각도·Rect barn door 줄이기, Light Function 활용). 8장 첫머리에서 본 "Sampling이 Shading보다 비싸다"도 이 도구들로 바로 확인되는 패턴이다.
</p>

<div class="card-grid">
<div class="card coral">
<div class="card-label">한계 1</div>
<div class="card-title">BVH 표현이 곧 화질 상한</div>
<div class="card-desc">그림자가 Ray Tracing에 전적으로 의존하니, <strong>BVH(프록시 메시) 품질이 곧 그림자 품질</strong>이다. 애니메이션·테셀레이션·Nanite 폴리지 등 동적·고밀도 지오메트리는 메모리·빌드·트래버설 모두에서 여전히 난제다.</div>
</div>
<div class="card gold">
<div class="card-label">한계 2</div>
<div class="card-title">1spp + 시간적 의존</div>
<div class="card-desc">콘솔에선 사실상 픽셀당 1광선. 빠른 카메라 이동이나 큰 광원·픽셀당 중요한 라이트가 많을 때는 <strong>여러 프레임 누적이 깨지며 시간적 아티팩트</strong>가 드러난다. 하이엔드 GPU에서 광선을 더 쏘면 완화된다.</div>
</div>
<div class="card blue">
<div class="card-label">한계 3</div>
<div class="card-title">요구 사항 / 확장성</div>
<div class="card-desc"><strong>Hardware Ray Tracing(SM6 + Wave Ops + RT) 필수, Deferred 렌더러 전용(Forward 미지원), 모바일·Switch·구세대 콘솔 미지원</strong>. Directional은 BVH로 먼 거리 샤프 섀도우가 어려워 VSM 의존. 한번 MegaLights로 라이팅한 콘텐츠를 <strong>모바일까지 스케일다운</strong>하는 것도 미해결 과제.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
그럼에도 강연의 결론은 분명하다. <strong>"라이트 개수가 더 이상 주요 제약이 아니다."</strong> 아티스트는 스플라인을 따라 라이트를 절차적으로 흩뿌리고, Rect 라이트를 마음껏 쓰고, 라이트 픽스처를 자유롭게 배치한다 — 시스템이 무너지기 전까지 훨씬 자유롭게. 그리고 stochastic 접근은 <strong>성능과 화질 사이를 슬라이더 하나로 조절</strong>할 수 있어, 스케일러빌리티 레벨마다 라이팅을 수작업으로 다시 맞추지 않아도 된다.
</p>

<span class="section-eyebrow">09 — 정리</span>
</div>

# 정리

<div class="ml-post">
<p style="color:var(--text2);line-height:1.85;">
MegaLights는 "라이트마다 일한다"는 Deferred의 전제를 버리고, <strong>"픽셀마다 고정 개수의 광선만 쏜다"</strong>로 갈아탄 직접 라이팅이다.
</p>

<div class="card-grid">
<div class="card teal">
<div class="card-label">선택</div>
<div class="card-title">WRS + Visible Light List</div>
<div class="card-desc"><code>log2(휘도)</code> 가중 Weighted Reservoir Sampling으로 라이트를 고르고, 이전 프레임 가시 목록 + 20% 숨은 라이트 예산으로 광선을 유도한다.</div>
</div>
<div class="card coral">
<div class="card-label">그림자</div>
<div class="card-title">RT 통합 (고정 비용)</div>
<div class="card-desc">Screen → Near → Far Field 트레이스로 모든 그림자를 통합. 라이트당 비용이 거의 없다. 까다로운 라이트는 VSM Fallback.</div>
</div>
<div class="card blue">
<div class="card-label">복원</div>
<div class="card-title">디노이저 친화 설계</div>
<div class="card-desc">ReSTIR의 reservoir 재사용 대신 STBN으로 비상관 패턴을 만들고, SVGF식 분산 기반 Temporal+Spatial 한 패스로 정리해 TSR에 넘긴다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 블로그의 다른 글과 함께 보면 그림이 완성된다. <a href="virtualshadowmap" style="color:var(--accent);font-weight:600;">Virtual Shadow Map</a>은 MegaLights가 Directional 등에서 Fallback으로 쓰는 그림자 구조이고, <a href="nanite" style="color:var(--accent);font-weight:600;">Nanite</a>의 고밀도 지오메트리는 MegaLights가 BVH로 표현해야 하는 바로 그 "한계 1"의 주인공이다. Nanite가 래스터에서 숨겨준 지오메트리 복잡도를, Ray Tracing이 다시 끌어내는 셈이다.
</p>

<div class="callout callout-info">
<div class="callout-title">한 줄 요약</div>
<p>MegaLights = <strong>(Weighted Reservoir Sampling으로 고른 소수의 라이트) × (Ray Tracing 통합 그림자) × (디노이저 친화 STBN 샘플링)</strong>. "라이트 개수"라는 오래된 예산 항목을 "픽셀당 샘플 수"로 바꿔치기한 기술.</p>
</div>
</div>
