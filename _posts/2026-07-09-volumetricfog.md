---
layout: post
title: "UE5.8 Volumetric Fog: 안개 낀 공기를 3D 텍스처 네 장으로 — 복셀화에서 Beer-Lambert 적분까지"
icon: paper
permalink: volumetric-fog
categories: Rendering
tags: [ComputerGraphics, Rendering, UnrealEngine, VolumetricFog, Froxel, BeerLambert, HenyeyGreenstein, MegaLights, Scattering]
excerpt: "Volumetric Fog는 '안개 낀 공기 그 자체가 빛을 받는' 효과다. UE5.8은 이것을 뷰 프러스텀에 정렬된 froxel 그리드 위에서 네 장의 3D 텍스처(VBufferA/B → LightScattering → IntegratedLightScattering)로 푼다. 이 글은 높이안개 밀도가 산란/소광 계수로 변환되는 MaterialSetupCS부터, 볼륨 머티리얼을 슬라이스별로 래스터화하는 GS 복셀화, Henyey-Greenstein 위상 함수와 방향광 CSM/VSM/클라우드 그림자 조합, 그림자 있는 로컬 라이트의 별도 주입 패스, Halton 지터와 conservative depth 기반 temporal reprojection, 그리고 Frostbite에서 온 energy-conserving Beer-Lambert 적분까지 — UE 5.8 소스를 코드로 끝까지 추적한다. froxel 글에서 약식으로 지나간 Volumetric Fog의 전체 파이프라인을 완전히 펼친 글이다."
back_color: "#ffffff"
img_name: "volumetricfog.png"
toc: false
show: true
new: true
series: -1
index: 18
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - Exponential Height Fog에서 "Volumetric Fog" 체크박스를 켜면 프레임에서 정확히 무슨 일이 벌어지는지 궁금한 분
> - 안개 속 빛줄기(god ray)가 레이마칭이 아니라 **3D 텍스처 룩업 한 번**으로 그려지는 구조가 궁금한 분
> - 산란·소광·알베도·위상 함수 같은 참여 매질(participating media) 용어가 UE 코드의 어떤 변수로 나타나는지 알고 싶은 분
> - `r.VolumetricFog.*` CVar를 튜닝해야 하는데 각 값이 파이프라인 어디에 꽂히는지 알고 싶은 분
> - [froxel 글](/froxel)에서 약식으로 지나간 Volumetric Fog 파이프라인의 나머지 전부가 궁금한 분
>
> **이 글로 알 수 있는 내용**
>
> - 참여 매질의 네 계수(σs, σa, σt, albedo)와 위상 함수가 UE의 `VolumetricFogAlbedo`/`ExtinctionScale`/`ScatteringDistribution`으로 매핑되는 방식
> - `ComputeVolumetricFog`가 프레임 어디에서 불리고, 7개 패스가 어떤 순서로 네 장의 3D 텍스처를 채우는지
> - MaterialSetupCS가 높이안개의 지수 밀도 함수를 froxel마다 다시 계산해 VBufferA(산란/소광)로 변환하는 코드
> - "Volume" 머티리얼 도메인이 지오메트리 셰이더로 Z슬라이스마다 복제 래스터화되는 복셀화 경로
> - LightScatteringCS 내부 — Henyey-Greenstein 위상 함수, 방향광의 4중 그림자 조합(CSM×VSM×레이트레이스×클라우드), 스카이 SH, Light Grid 루프, 그림자 로컬 라이트의 별도 주입 패스
> - Halton 수열 지터 + conservative depth 기반 history 거부로 이루어지는 temporal reprojection의 실제 코드
> - FinalIntegrationCS의 energy-conserving Beer-Lambert 적분 — naive한 `S·d` 누적이 왜 틀렸고 `(S−S·T)/σt`가 왜 맞는지 유도
> - MegaLights가 안개 볼륨에 스토캐스틱 그림자 라이팅을 공급하는 연동 지점과 이중 계산 방지 장치
> - `r.VolumetricFog.*` 주요 CVar가 파이프라인 어느 단계에 꽂히는지 한눈에 보는 표

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.vf-post {
  --bg2: #f2f3fb;
  --surface: #f8f9fd;
  --surface2: #edeffa;
  --border: rgba(79,70,229,0.10);
  --border2: rgba(79,70,229,0.24);
  --text: #1b1d2e;
  --text2: #454864;
  --text3: #85889f;
  --accent: #4f46e5;
  --accent2: #0ea5b3;
  --gold: #b07d00;
  --teal: #0a8f72;
  --coral: #d6304a;
}
.vf-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.vf-post .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.vf-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.vf-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.vf-post .card.blue::before   { background: var(--accent); }
.vf-post .card.gold::before   { background: var(--gold); }
.vf-post .card.teal::before   { background: var(--teal); }
.vf-post .card.coral::before  { background: var(--coral); }
.vf-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.vf-post .card.blue   .card-label { color: var(--accent); }
.vf-post .card.gold   .card-label { color: var(--gold); }
.vf-post .card.teal   .card-label { color: var(--teal); }
.vf-post .card.coral  .card-label { color: var(--coral); }
.vf-post .card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.vf-post .card-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.vf-post .callout {
  border-radius: 12px;
  padding: 16px 20px;
  margin: 20px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.vf-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.vf-post .callout-info { background: rgba(79,70,229,0.05); border-color: rgba(79,70,229,0.18); }
.vf-post .callout-info::before { background: var(--accent); }
.vf-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.vf-post .callout-warn::before { background: var(--gold); }
.vf-post .callout-teal { background: rgba(10,143,98,0.05); border-color: rgba(10,143,98,0.20); }
.vf-post .callout-teal::before { background: var(--teal); }
.vf-post .callout-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.vf-post .callout-info .callout-title { color: var(--accent); }
.vf-post .callout-warn .callout-title { color: var(--gold); }
.vf-post .callout-teal .callout-title { color: var(--teal); }
.vf-post .callout p { margin: 0 0 8px 0; font-size: 13px; color: var(--text2); line-height: 1.75; }
.vf-post .callout p:last-child { margin: 0; }
.vf-post .code-block {
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
.vf-post .code-block .kw  { color: #a78bfa; }
.vf-post .code-block .fn  { color: #34d399; }
.vf-post .code-block .cm  { color: #525a78; font-style: italic; }
.vf-post .code-block .num { color: #fb923c; }
.vf-post .code-block .str { color: #fbbf24; }
.vf-post .code-block .ty  { color: #38bdf8; }
.vf-post .code-lang {
  position: absolute;
  top: 10px; right: 14px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #525a78;
}
.vf-post .flow-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 24px 0;
  overflow-x: auto;
}
.vf-post .flow-step {
  flex: 1;
  min-width: 118px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 14px 16px;
  position: relative;
  text-align: center;
}
.vf-post .flow-step .step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 4px;
}
.vf-post .flow-step .step-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.vf-post .flow-step .step-desc {
  font-size: 11px;
  color: var(--text2);
  line-height: 1.5;
}
.vf-post .flow-arrow {
  display: flex;
  align-items: center;
  padding: 0 6px;
  color: var(--text3);
  font-size: 18px;
  flex-shrink: 0;
}
.vf-post .flag-badge {
  display: inline-block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 5px;
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.vf-post .flag-coral  { background: rgba(214,48,49,0.12);  color: var(--coral); }
.vf-post .flag-blue   { background: rgba(79,70,229,0.12);  color: var(--accent); }
.vf-post .flag-teal   { background: rgba(10,143,98,0.12);  color: var(--teal); }
.vf-post .flag-gold   { background: rgba(176,125,0,0.12);  color: var(--gold); }
.vf-post .flag-purple { background: rgba(14,165,179,0.12); color: var(--accent2); }
.vf-post .flag-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 14px; }
.vf-post .data-table { overflow-x: auto; margin: 24px 0; }
.vf-post .data-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
.vf-post .data-table th {
  padding: 10px 14px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--accent);
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
}
.vf-post .data-table td { padding: 9px 14px; border: 1px solid var(--border); color: var(--text2); }
.vf-post .data-table tr:nth-child(even) td { background: var(--surface); }
.vf-post .data-table code { font-size: 12px; }
.vf-post .formula {
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

<div class="vf-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: 안개가 "표면"이 아니라 "공간"이라는 문제

<div class="vf-post">
<p style="color:var(--text2);line-height:1.85;">
일반적인 셰이딩은 표면에서 일어난다 — 픽셀 하나에는 그 픽셀이 보는 표면 한 점이 있고, 그 점의 BRDF에 라이트를 곱한다. 그런데 안개는 표면이 없다. 카메라에서 픽셀까지 가는 시선(view ray)이 통과하는 <strong>공기의 모든 지점</strong>이 조금씩 빛을 산란시켜 카메라로 보내고(in-scattering), 동시에 뒤쪽에서 오던 빛을 조금씩 가로막는다(extinction). 즉 픽셀 하나의 안개 기여를 정확히 구하려면 시선을 따라 <strong>적분</strong>해야 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
UE의 Volumetric Fog는 이 적분을 매 픽셀 레이마칭으로 풀지 않는다. 뷰 프러스텀에 정렬된 <strong>froxel 그리드</strong>(기본 화면 16픽셀 타일 × 64 깊이 슬라이스) 위에 안개의 물성과 입사광을 미리 구워 두고, 깊이 방향 누적 적분까지 끝낸 3D 텍스처(<code>IntegratedLightScattering</code>)를 만들어 둔다. 그러면 씬의 어떤 픽셀이든 — 불투명이든 반투명이든 파티클이든 — <strong>3D 텍스처 룩업 한 번</strong>으로 "여기까지 오는 동안 안개가 더한 빛"과 "여기까지 오는 동안 안개가 남긴 투과율"을 얻는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 froxel 좌표계 자체와 Light Grid 자료구조는 <a href="/froxel">이전 글(UE5.8 Froxel)</a>에서 자세히 다뤘다. 그 글의 04장이 Volumetric Fog를 "자료구조 관점"에서 요약했다면, 이 글은 반대로 <strong>파이프라인 전체를 패스 단위로 펼친다</strong> — 높이안개 밀도가 산란 계수로 바뀌는 순간부터, 볼륨 머티리얼이 래스터화되는 방식, 라이트별 그림자 처리의 세 갈래 길, 시간축 안정화, 그리고 최종 적분의 수학까지.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>UE 5.8 소스(<code>VolumetricFog.cpp/.h</code>, <code>VolumetricFog.usf</code>, <code>VolumetricFogVoxelization.cpp/.usf</code>, <code>VolumetricFogLightFunction.cpp</code>, <code>HeightFogCommon.ush</code>, <code>ParticipatingMediaCommon.ush</code>, <code>FogRendering.cpp</code>, <code>MegaLights/*</code>)를 직접 읽고 정리했다. 업계 배경은 Bart Wronski의 SIGGRAPH 2014 발표(Assassin's Creed 4의 Volumetric Fog — 이 구조의 원형)와 Sebastien Hillaire의 SIGGRAPH 2015 발표(Frostbite — UE 소스 주석이 직접 인용하는 energy-conserving 적분의 출처)를 근거로 했다. 모든 코드 인용은 실제 소스를 그대로 옮긴 것이다.</p>
</div>

<span class="section-eyebrow">01 — 물리 배경</span>
</div>

# 참여 매질: 계수 넷과 함수 하나면 된다

<div class="vf-post">
<p style="color:var(--text2);line-height:1.85;">
빛이 통과하는 도중에 상호작용하는 매질을 <strong>참여 매질(participating media)</strong>이라 부른다. 안개, 연기, 먼지, 구름이 전부 여기에 속한다. 빛과 매질의 상호작용은 딱 네 가지다 — 흡수(absorption, 빛이 열로 사라짐), 외산란(out-scattering, 빛이 다른 방향으로 튕겨나감), 내산란(in-scattering, 다른 방향의 빛이 시선 방향으로 튕겨 들어옴), 방출(emission, 매질 스스로 빛남). 이걸 수치로 다루기 위한 계수가 다음과 같다.
</p>

<div class="card-grid">
<div class="card coral">
<div class="card-label">σa — absorption</div>
<div class="card-title">흡수 계수</div>
<div class="card-desc">단위 거리당 빛이 흡수되어 사라지는 비율.</div>
</div>
<div class="card gold">
<div class="card-label">σs — scattering</div>
<div class="card-title">산란 계수</div>
<div class="card-desc">단위 거리당 빛이 다른 방향으로 산란되는 비율. 내산란의 세기도 이 계수가 정한다.</div>
</div>
<div class="card blue">
<div class="card-label">σt = σa + σs</div>
<div class="card-title">소광(extinction) 계수</div>
<div class="card-desc">흡수든 산란이든, 시선 방향에서 빛이 "빠져나가는" 총 비율. Beer-Lambert 감쇠의 지수가 된다.</div>
</div>
<div class="card teal">
<div class="card-label">ρ = σs / σt</div>
<div class="card-title">알베도(albedo)</div>
<div class="card-desc">빠져나간 빛 중 산란(=다시 살아날 기회가 있는 쪽)의 비율. 1에 가까울수록 하얗고 밝은 매질(구름), 낮을수록 어두운 매질(매연).</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
남은 하나는 <strong>위상 함수(phase function)</strong> p(θ)다. 산란이 일어날 때 빛이 <strong>어느 방향으로</strong> 튕기는지의 확률 분포로, 표면 셰이딩의 BRDF에 해당하는 물건이다. 공기 중 물방울처럼 파장보다 큰 입자는 빛을 앞쪽으로 몰아서 산란시키는데(Mie 산란), 이를 값싸게 근사하는 것이 06장에서 볼 <strong>Henyey-Greenstein</strong> 함수다.
</p>

<div class="callout callout-teal">
<div class="callout-title">UE 파라미터로의 매핑</div>
<p>UE의 Exponential Height Fog 컴포넌트는 σs, σa를 직접 노출하지 않는다. 대신 <strong>Albedo</strong>(<code>VolumetricFogAlbedo</code>)와 <strong>Extinction Scale</strong>(<code>VolumetricFogExtinctionScale</code>), 그리고 밀도(높이안개의 지수 함수)를 노출하고, 내부에서 <code>σt = 밀도 × ExtinctionScale</code>, <code>σs = Albedo × σt</code>로 조립한다(04장). 위상 함수의 비등방성 g는 <strong>Scattering Distribution</strong>(<code>VolumetricFogScatteringDistribution</code>, 셰이더의 <code>PhaseG</code>)이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 <strong>Beer-Lambert 법칙</strong>. 소광 계수 σt인 매질을 거리 d만큼 통과한 빛의 투과율(transmittance)은 지수 감쇠를 따른다.
</p>

<div class="formula">T(d) = exp(−σt · d)</div>

<p style="color:var(--text2);line-height:1.85;">
이 식 하나가 09장의 적분 루프에서 <code>exp(-Extinction * StepLength)</code>라는 코드 한 줄로 나타난다. 여기까지가 필요한 물리의 전부다.
</p>

<span class="section-eyebrow">02 — 전체 그림</span>
</div>

# 전체 그림: 프레임 속 위치와 일곱 개의 패스

<div class="vf-post">
<div class="flag-row"><span class="flag-badge flag-gold">VolumetricFog.cpp</span><span class="flag-badge flag-blue">DeferredShadingRenderer.cpp</span></div>

<p style="color:var(--text2);line-height:1.85;">
진입점은 <code>FSceneRenderer::ComputeVolumetricFog</code>(<code>VolumetricFog.cpp:1499</code>)다. 디퍼드 경로에서는 <strong>Lumen GI와 섀도우 뎁스 렌더링이 끝난 뒤</strong>(<code>DeferredShadingRenderer.cpp:3663</code>, 주석 그대로 "Volumetric fog after Lumen GI and shadow depths") 호출된다 — 안개가 GI 볼륨과 그림자맵을 읽어야 하기 때문이다. 반대로 포워드 셰이딩에서는 <strong>베이스 패스보다 먼저</strong>(<code>:2943</code>) 돈다 — 포워드는 베이스 패스가 안개를 직접 샘플링해 입히기 때문이다. 실행 조건은 <code>ShouldRenderVolumetricFog</code>(<code>:1355</code>): 씬에 Exponential Height Fog가 있고, <code>bEnableVolumetricFog</code>가 켜져 있고, <code>VolumetricFogDistance &gt; 0</code>이어야 한다. 즉 <strong>Volumetric Fog는 독립 액터가 아니라 높이안개 컴포넌트의 확장 모드</strong>다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<code>ComputeVolumetricFog</code> 안에서 뷰마다 다음 순서로 패스가 돈다. 가운데 네 단계(3~6)가 핵심 데이터 흐름 — <a href="/froxel">froxel 글</a>에서 봤던 4장의 <code>PF_FloatRGBA</code> 3D 텍스처를 차례로 채우는 과정이다.
</p>

<div class="flow-row">
<div class="flow-step">
<div class="step-num">1</div>
<div class="step-name">Conservative Depth</div>
<div class="step-desc">froxel 타일별 최전방 깊이 2D 텍스처(R16F). 불투명 뒤 froxel 스킵용</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">2</div>
<div class="step-name">보조 라이트 패스</div>
<div class="step-desc">방향광 라이트 펑션 2D 텍스처 + 그림자 로컬 라이트 별도 주입(06장)</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">3</div>
<div class="step-name">MaterialSetupCS</div>
<div class="step-desc">높이안개+Local Fog Volume → VBufferA/B (04장)</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">4</div>
<div class="step-name">Voxelize</div>
<div class="step-desc">Volume 머티리얼 프리미티브를 슬라이스별 래스터화, 가산 블렌드 (05장)</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">5</div>
<div class="step-name">LightScatteringCS</div>
<div class="step-desc">froxel마다 입사광 계산 + temporal reprojection (06~08장)</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">6</div>
<div class="step-name">FinalIntegrationCS</div>
<div class="step-desc">앞→뒤 Beer-Lambert 누적 적분 (09장)</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">7</div>
<div class="step-name">씬 합성</div>
<div class="step-desc">높이안개 패스가 3D 룩업 한 번으로 적용 (10장)</div>
</div>
</div>

<div class="data-table">
<table>
<thead><tr><th>텍스처</th><th>채우는 패스</th><th>.rgb</th><th>.a</th></tr></thead>
<tbody>
<tr><td><code>VBufferA</code></td><td>MaterialSetupCS + Voxelize</td><td>산란 계수 σs (= Albedo × σt)</td><td>소광 계수 σt</td></tr>
<tr><td><code>VBufferB</code> (선택)</td><td>MaterialSetupCS + Voxelize</td><td>이미시브</td><td>미사용</td></tr>
<tr><td><code>LightScattering</code></td><td>LightScatteringCS</td><td>입사광 × σs + 이미시브 (pre-exposed)</td><td>σt (그대로 전달)</td></tr>
<tr><td><code>IntegratedLightScattering</code></td><td>FinalIntegrationCS</td><td>카메라→해당 슬라이스 누적 산란광</td><td>누적 투과율</td></tr>
</tbody>
</table>
</div>

<div class="callout callout-info">
<div class="callout-title">그리드 크기 — froxel 글 요약</div>
<p>안개 그리드는 화면 16픽셀 타일(<code>r.VolumetricFog.GridPixelSize</code>=16) × 64 깊이 슬라이스(<code>r.VolumetricFog.GridSizeZ</code>=64)로, 1080p 기준 약 <strong>120×68×64 ≈ 52만 froxel</strong>이다. 깊이는 선형이 아니라 로그 분포 — <code>CalculateGridZParams(near, far, DepthDistributionScale=32, 64)</code>가 만든 (B, O, S) 계수로 <code>slice = log2(z·B + O)·S</code> 변환을 쓴다. 가까울수록 슬라이스가 얇아 디테일이 살고, 멀수록 두꺼워진다. 이 수학과 Light Grid(64px×32슬라이스)와의 관계는 <a href="/froxel">froxel 글 06장</a>에 유도가 있다. 한 가지 구현 디테일: 텍스처는 <strong>ResourceGrid</strong>(SceneTexture 최대 크기 기준)로 할당하고 실제 계산은 <strong>ViewGrid</strong>(현재 ViewRect 기준)만 돈다 — 다이내믹 레졸루션이 출렁여도 3D 텍스처를 재할당하지 않기 위해서다.</p>
</div>

<span class="section-eyebrow">03 — 채우기 ①</span>
</div>

# MaterialSetupCS: 높이안개 밀도가 산란/소광 계수가 되는 순간

<div class="vf-post">
<div class="flag-row"><span class="flag-badge flag-gold">VolumetricFog.usf — MaterialSetupCS</span><span class="flag-badge flag-teal">4×4×4 threadgroup</span></div>

<p style="color:var(--text2);line-height:1.85;">
첫 컴퓨트 패스(RDG 이름 <code>InitializeVolumeAttributes</code>)는 froxel 하나마다 스레드 하나를 배정해 "이 지점의 공기가 어떤 매질인가"를 계산한다. 재미있는 점은 Exponential Height Fog의 밀도 함수를 <strong>froxel의 월드 높이에서 그대로 다시 계산</strong>한다는 것 — 픽셀 셰이더용 분석 공식과 같은 파라미터(<code>FogStruct.ExponentialFogParameters</code>)를 읽어서, 두 개의 지수 밀도 항을 더한다.
</p>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFog.usf:167 (MaterialSetupCS 요지)</div><span class="kw">float3</span> WorldPosition = <span class="fn">ComputeCellTranslatedWorldPosition</span>(GridCoordinate, VoxelOffset) - PreViewTranslation;

<span class="cm">// 높이안개의 두 지수 밀도 항을 froxel 높이에서 재계산</span>
<span class="kw">float</span> GlobalDensityFirst  = ExponentialFogParameters3.x * <span class="fn">exp2</span>(-ExponentialFogParameters.y  * (WorldPosition.z - ExponentialFogParameters3.y));
<span class="kw">float</span> GlobalDensitySecond = ExponentialFogParameters2.z * <span class="fn">exp2</span>(-ExponentialFogParameters2.y * (WorldPosition.z - ExponentialFogParameters2.w));
<span class="kw">float</span> GlobalDensity = GlobalDensityFirst + GlobalDensitySecond;

<span class="kw">float3</span> Albedo = GlobalAlbedo.rgb;
<span class="kw">float</span> MatchHeightFogFactor = <span class="num">.5f</span>;
GlobalDensity *= MatchHeightFogFactor;      <span class="cm">// 분석적 높이안개와 시각적 밀도를 맞추는 보정</span>

<span class="kw">float</span> Extinction  = <span class="fn">max</span>(GlobalDensity * GlobalExtinctionScale, <span class="num">0</span>);   <span class="cm">// σt</span>
<span class="kw">float3</span> Scattering = Albedo * Extinction;                             <span class="cm">// σs = ρ·σt</span></div>

<p style="color:var(--text2);line-height:1.85;">
01장의 매핑이 코드로 그대로 나타난다 — <strong>밀도 × ExtinctionScale = σt</strong>, <strong>Albedo × σt = σs</strong>. 여기에 프로젝트에 배치된 <strong>Local Fog Volume</strong>(분석적 안개 볼륨 액터)이 있으면 타일별 리스트를 순회하며 기여를 더하는데, 반경 방향 감쇠와 높이 감쇠 두 커버리지를 <strong>광학 깊이(optical depth) 공간에서 결합</strong>하는 점이 눈에 띈다. 투과율은 곱해져야 하므로(<code>T = T_radial × T_height</code>) 소광 계수는 단순 덧셈이 아니라 <code>σt = −log(T_radial × T_height)</code> 꼴로 합쳐야 한다는, 지수 함수의 성질을 정확히 따른 코드다.
</p>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFog.usf:287 (최종 기록)</div>RWVBufferA[GridCoordinate] = <span class="fn">float4</span>(Scattering, Extinction);
<span class="kw">#if</span> USE_EMISSIVE
    RWVBufferB[GridCoordinate] = <span class="fn">float4</span>(HeightFogEmissive.rgb + AdditionalEmissive, <span class="num">0</span>);
<span class="kw">#endif</span></div>

<p style="color:var(--text2);line-height:1.85;">
<code>VBufferB</code>는 이미시브를 쓰는 경우에만 아예 <strong>텍스처 자체가 할당된다</strong>(<code>bUseEmissive</code>, <code>VolumetricFog.cpp:1706</code>) — 셰이더 퍼뮤테이션 <code>USE_EMISSIVE</code>로 UAV 바인딩까지 제거한다. 이미시브 없는 씬에서는 3D 텍스처 한 장 분량의 메모리와 대역폭이 통째로 절약된다.
</p>

<span class="section-eyebrow">04 — 채우기 ②</span>
</div>

# 복셀화: "Volume" 머티리얼은 슬라이스마다 래스터화된다

<div class="vf-post">
<div class="flag-row"><span class="flag-badge flag-gold">VolumetricFogVoxelization.cpp/.usf</span><span class="flag-badge flag-coral">MD_Volume 전용</span></div>

<p style="color:var(--text2);line-height:1.85;">
머티리얼 도메인을 <strong>Volume</strong>으로 설정한 머티리얼(연기 파티클, 국소 안개 메시 등)은 컴퓨트가 아니라 <strong>진짜 드로우콜</strong>로 VBufferA/B에 들어간다. 3D 텍스처의 각 Z슬라이스를 렌더타깃 배열의 한 장으로 보고, 프리미티브가 걸치는 슬라이스마다 지오메트리를 복제 래스터화하는 방식이다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">VoxelizeVS</div>
<div class="card-title">뷰 공간 변환</div>
<div class="card-desc">프리미티브를 뷰 공간으로 변환. 파티클이 아닌 버텍스 팩토리는 카메라를 향한 쿼드로 대체된다(<code>GQuadMeshVertexFactory</code>).</div>
</div>
<div class="card gold">
<div class="card-label">VoxelizeGS</div>
<div class="card-title">슬라이스 복제</div>
<div class="card-desc">프리미티브의 뷰 공간 Z 범위를 <code>ComputeZSliceFromDepth</code>로 슬라이스 구간 [Closest, Furthest]로 바꾸고, 그 구간의 슬라이스마다 삼각형을 복제해 <code>SV_RenderTargetArrayIndex</code>로 내보낸다. GS 한 번에 최대 8슬라이스(<code>r.VolumetricFog.VoxelizationSlicesPerGSPass</code>), 넘치면 드로우콜을 나눈다. GS가 없는 플랫폼은 vertex shader layer로 대체.</div>
</div>
<div class="card teal">
<div class="card-label">VoxelizePS</div>
<div class="card-title">머티리얼 평가</div>
<div class="card-desc">머티리얼의 Albedo/Emissive/Extinction 출력을 읽어 froxel에 기록. 구 모드는 슬라이스 평면과 바운딩 스피어의 교차원 반지름(<code>sqrt(r²−d²)</code>)으로 쿼드를 줄인다.</div>
</div>
</div>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFogVoxelization.usf:167, 343 (지터된 슬라이스 깊이와 최종 출력)</div><span class="cm">// GS: 슬라이스 인덱스에 프레임 지터를 더한 깊이에서 단면을 계산</span>
<span class="kw">float</span> SliceDepth = <span class="fn">ComputeDepthFromZSlice</span>(SliceIndex + VoxelizeVolumePass.FrameJitterOffset0.z);

<span class="cm">// PS: MaterialSetupCS와 같은 (σs, σt) 규약으로 가산 블렌딩</span>
OutVBufferA = <span class="fn">float4</span>(Scattering * Scale, Extinction * Scale);
OutVBufferB = <span class="fn">float4</span>(EmissiveColor * Scale, <span class="num">0</span>);</div>

<p style="color:var(--text2);line-height:1.85;">
블렌드 스테이트는 두 렌더타깃 모두 <strong>가산(BO_Add, BF_One/BF_One)</strong>, 깊이 테스트는 <code>CF_Always</code>, 컬링 없음 — 즉 여러 볼륨이 겹치면 산란/소광 계수가 그냥 더해진다(물리적으로도 매질이 겹치면 계수는 더해지는 게 맞다). 슬라이스 깊이에 08장의 <strong>프레임 지터가 GS 단계부터</strong> 들어가 있는 것도 눈여겨볼 부분 — 복셀화 자체가 프레임마다 살짝 다른 깊이에서 단면을 뜨고, temporal reprojection이 이를 평균 내서 슬라이스 개수 이상의 유효 해상도를 만든다.
</p>

<span class="section-eyebrow">05 — 라이팅 준비</span>
</div>

# 라이트는 세 갈래 길로 froxel에 들어온다

<div class="vf-post">
<p style="color:var(--text2);line-height:1.85;">
이제 매질은 준비됐으니 빛을 넣을 차례다. UE는 라이트의 성격에 따라 <strong>세 가지 경로</strong>로 나눠 froxel에 빛을 주입한다. 이 분류를 먼저 잡아야 06장의 거대한 <code>LightScatteringCS</code>가 읽힌다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">경로 A — 인라인</div>
<div class="card-title">방향광 + 그림자 없는 로컬 라이트</div>
<div class="card-desc">LightScatteringCS 안에서 직접 계산. 방향광은 CSM/VSM/클라우드 그림자까지 인라인으로 샘플링하고, 로컬 라이트는 <a href="/froxel">Light Grid</a>를 순회한다 — 단, 이 경로의 로컬 라이트는 <strong>볼륨 그림자가 없다</strong>.</div>
</div>
<div class="card coral">
<div class="card-label">경로 B — 별도 주입</div>
<div class="card-title">그림자 있는 로컬 라이트</div>
<div class="card-desc">포인트/스팟/렉트 중 다이내믹 섀도우를 드리우는 라이트는 <code>InjectShadowedLocalLightPS</code>로 <strong>라이트당 한 패스씩</strong> 먼저 렌더링해 <code>LocalShadowedLightScattering</code> 텍스처에 누적해 둔다. 그림자맵/VSM/레이트레이스 샘플링이 여기서 일어난다.</div>
</div>
<div class="card teal">
<div class="card-label">경로 C — MegaLights</div>
<div class="card-title">MegaLights가 맡은 라이트</div>
<div class="card-desc">MegaLights가 켜져 있으면 해당 라이트들은 스토캐스틱 볼륨 파이프라인이 별도 3D 텍스처로 계산하고, LightScatteringCS는 그 결과를 더하기만 한다(07장).</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
경로 B의 진입 조건은 <code>LightNeedsSeparateInjectionIntoVolumetricFogForOpaqueShadow</code>(<code>VolumetricFog.cpp:731</code>) — <code>r.VolumetricFog.InjectShadowedLightsSeparately</code>(기본 1)가 켜져 있고, 라이트가 볼류메트릭 그림자를 드리우며, 홀씬 섀도우맵·정적 섀도우 뎁스맵·Virtual Shadow Map·레이트레이스 그림자 중 하나를 갖고 있어야 한다. 렌더링 방식이 재미있다 — 컴퓨트가 아니라 <strong>라이트의 영향 반경을 감싸는 카메라 지향 원판을, 라이트가 걸치는 Z슬라이스마다 인스턴싱해 래스터화</strong>한다(<code>FWriteToBoundingSphereVS</code> + <code>WriteToSliceGS</code>). 픽셀 셰이더는 froxel 위치에서 <code>ComputeVolumeShadowing</code>(재래식 그림자맵)이나 <code>SampleVirtualShadowMapTranslatedWorld</code>(VSM)를 샘플링해 그림자가 반영된 산란광을 가산 블렌딩으로 쌓는다. 라이트가 닿지 않는 froxel은 래스터라이저가 알아서 걸러 주는, 04장 복셀화와 같은 발상이다.
</p>

<div class="callout callout-warn">
<div class="callout-title">왜 나눴을까</div>
<p>모든 라이트를 LightScatteringCS 안에서 그림자까지 처리하면 셰이더 하나가 모든 그림자맵을 바인딩해야 하고, froxel마다 모든 라이트의 그림자를 샘플링하는 최악 경로가 생긴다. 그림자 있는 라이트를 라이트별 래스터 패스로 분리하면 <strong>각 패스는 자기 그림자맵 하나만 바인딩</strong>하고, 영향 범위 밖 froxel은 아예 실행되지 않는다. 방향광만은 화면 전체에 영향을 주므로 분리해도 이득이 없어 인라인으로 남았다.</p>
</div>

<span class="section-eyebrow">06 — 라이팅 본체</span>
</div>

# LightScatteringCS: froxel 하나의 입사광을 다 더한다

<div class="vf-post">
<div class="flag-row"><span class="flag-badge flag-gold">VolumetricFog.usf — LightScatteringCS</span><span class="flag-badge flag-teal">4×4×4 threadgroup</span><span class="flag-badge flag-purple">10개 퍼뮤테이션 + 우버셰이더</span></div>

<p style="color:var(--text2);line-height:1.85;">
파이프라인의 심장이다. froxel마다 스레드 하나가 (1) 지터된 월드 좌표를 잡고, (2) 방향광·스카이·GI·로컬 라이트의 기여를 위상 함수와 함께 더하고, (3) 경로 B/C의 결과 텍스처를 합치고, (4) 매질 계수와 결합한 뒤, (5) 지난 프레임과 블렌딩해 <code>LightScattering</code>에 쓴다. 순서대로 따라가 보자.
</p>

<h2>샘플 위치: 지터가 먼저다</h2>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFog.usf:917 (froxel 내 샘플 위치 결정)</div><span class="kw">uint3</span> Rand32Bits = <span class="fn">Rand4DPCG32</span>(<span class="fn">int4</span>(GridCoordinate.xyz, View.StateFrameIndexMod8 + <span class="num">8</span> * SampleIndex)).xyz;
<span class="kw">float3</span> CellOffset = FrameJitterOffsets[SampleIndex].xyz + LightScatteringSampleJitterMultiplier * Rand3D;
<span class="fn">ApplyDepthConstraintsToOffset</span>(GridCoordinate, CellOffset);   <span class="cm">// 샘플 z를 깊이버퍼 쪽으로 스냅 — 벽 뒤 라이트 누출 감소</span>
<span class="kw">float3</span> TranslatedWorldPosition = <span class="fn">ComputeCellTranslatedWorldPosition</span>(GridCoordinate, CellOffset, SceneDepth);</div>

<p style="color:var(--text2);line-height:1.85;">
froxel 하나는 화면 16픽셀 × 수 미터 깊이짜리 커다란 상자다. 항상 중심에서만 샘플링하면 상자보다 작은 그림자 경계나 라이트 감쇠가 계단으로 뭉개진다. 그래서 <strong>프레임마다 다른 위치</strong>(<code>FrameJitterOffsets[0]</code> — Halton(2,3,5) 수열, 08장)에서 샘플링하고 시간축으로 평균 낸다. <code>ApplyDepthConstraintsToOffset</code>은 5.8의 디테일 — 불투명 표면 바로 앞 froxel은 샘플 z를 깊이버퍼 근처로 끌어당겨(<code>r.VolumetricFog.GridCenterOffsetFromDepthBuffer</code>), 벽 뒤에 있는 라이트가 벽 앞 froxel로 새는 고전적인 아티팩트를 줄인다.
</p>

<h2>위상 함수: Henyey-Greenstein</h2>

<div class="code-block"><div class="code-lang">HLSL — ParticipatingMediaCommon.ush:91 (HenyeyGreensteinPhase)</div><span class="kw">float</span> <span class="fn">HenyeyGreensteinPhase</span>(<span class="kw">float</span> G, <span class="kw">float</span> CosTheta)
{
    <span class="cm">// [Henyey and Greenstein 1941]</span>
    <span class="kw">float</span> Numer = <span class="num">1.0f</span> - G * G;
    <span class="kw">float</span> Denom = <span class="num">1.0f</span> + G * G + <span class="num">2.0f</span> * G * CosTheta;
    <span class="kw">return</span> Numer / (<span class="num">4.0f</span> * PI * Denom * <span class="fn">sqrt</span>(Denom));
}</div>

<p style="color:var(--text2);line-height:1.85;">
비등방성 g(<code>PhaseG</code>) 하나로 산란의 방향성을 조절한다 — g=0이면 완전 등방(모든 방향 균등), g→1이면 전방 산란(빛의 진행 방향으로 몰림). 안개 속에서 <strong>광원을 마주볼 때 주변이 훨씬 밝게 피어오르는</strong> 현상이 이 함수에서 나온다. 1941년 천문학 논문의 식이 그대로 실시간 렌더러에 들어와 있는 셈인데, 값이 싸고(나눗셈 한 번, sqrt 한 번), Wronski가 지적했듯 구면조화(SH)로 깔끔하게 전개된다는 점이 실시간에서 살아남은 이유다. 그 SH 전개는 바로 아래 스카이 라이팅에서 쓰인다.
</p>

<h2>방향광: 그림자 넷을 곱한다</h2>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFog.usf:946~986 (방향광, 요지)</div><span class="kw">float</span> ShadowFactor = <span class="fn">ComputeDirectionalLightStaticShadowing</span>(TranslatedWorldPosition)
                   * <span class="fn">ComputeDirectionalLightDynamicShadowing</span>(TranslatedWorldPosition, SceneDepth);  <span class="cm">// CSM</span>

<span class="kw">if</span> (bVirtualShadowMap)
    ShadowFactor *= <span class="fn">SampleVirtualShadowMapTranslatedWorld</span>(ForwardLightStruct.DirectionalLightVSM, TranslatedWorldPosition);

ShadowFactor *= RaytracedShadowsVolume[GridCoordinate];        <span class="cm">// 레이트레이스 그림자 볼륨(옵션)</span>
ShadowFactor *= <span class="fn">GetCloudVolumetricShadow</span>(TranslatedWorldPosition);  <span class="cm">// 볼류메트릭 클라우드 그림자</span>

LightScattering += DirectionalLightColor * LightFunctionColor * ShadowFactor
                 * <span class="fn">PhaseFunction</span>(PhaseG, <span class="fn">dot</span>(DirectionalLightDirection, -CameraVector));</div>

<p style="color:var(--text2);line-height:1.85;">
정적 그림자 × CSM × VSM × 레이트레이스 × 구름 그림자가 전부 <strong>곱</strong>으로 결합된다 — 어떤 경로로든 가려졌다면 빛은 없다. 이 조합이 만드는 것이 바로 <strong>volumetric shadow, 즉 빛줄기(light shaft)</strong>다: 그림자에 걸린 froxel만 어두워지니, 적분 후 화면에는 구름 틈이나 창틀 사이로 뻗는 밝은 기둥이 남는다. 라이트 펑션은 이 패스 전에 <code>VolumetricFogLightFunction.cpp</code>가 방향광 시점의 2D 텍스처로 미리 구워 두고 여기서 투영 샘플링한다.
</p>

<h2>스카이·GI: SH 위에서 위상 함수를 돌린다</h2>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFog.usf:989~1050 (앰비언트 계열, 요지)</div><span class="cm">// HG 위상 함수의 SH(zonal harmonic) 근사를 시선 방향으로 회전</span>
FTwoBandSHVector RotatedHGZonalHarmonic;
RotatedHGZonalHarmonic.V = <span class="fn">float4</span>(<span class="num">1</span>, CameraVector.y, CameraVector.z, CameraVector.x) * <span class="fn">float4</span>(<span class="num">1</span>, PhaseG, PhaseG, PhaseG);

<span class="kw">#if</span> LUMEN_GI   <span class="cm">// Lumen Translucency GI 볼륨의 SH와 내적</span>
    LightScattering += <span class="fn">max</span>(<span class="fn">DotSH</span>(TranslucencyGISH, RotatedHGZonalHarmonic), <span class="num">0</span>);
<span class="kw">#endif</span>
<span class="cm">// 스카이라이트: 큐브맵 SH를 위상 방향으로 샘플 + DFAO/볼류메트릭 라이트맵 벤트 노멀 가림</span>
LightScattering += SkyVisibility * (View.SkyLightColor * <span class="fn">GetSkySHDiffuseSimple</span>(CameraVector * -PhaseG));
<span class="cm">// 볼류메트릭 라이트맵(정적 라이팅) SH</span>
LightScattering += (StaticLightingScatteringIntensity / PI) * <span class="fn">max</span>(<span class="fn">DotSH</span>(IrradianceSH, RotatedHGZonalHarmonic), <span class="num">0</span>);</div>

<p style="color:var(--text2);line-height:1.85;">
모든 방향에서 오는 앰비언트 광은 방향별로 적분해야 하지만, 라이팅이 이미 SH로 저장돼 있다면(스카이라이트, Lumen GI 볼륨, 볼류메트릭 라이트맵) <strong>위상 함수의 SH 근사와 내적 한 번</strong>으로 그 적분이 끝난다 — 이것이 위에서 말한 "HG가 SH로 전개된다"의 실전 활용이다. 스카이 가시성은 Lumen이 꺼진 경우 Distance Field 콘 트레이스(<code>HemisphereConeTraceAgainstGlobalDistanceField</code>)나 볼류메트릭 라이트맵의 sky bent normal로 근사한다.
</p>

<h2>로컬 라이트: Light Grid 루프</h2>

<p style="color:var(--text2);line-height:1.85;">
그림자 없는 포인트/스팟/렉트 라이트는 <a href="/froxel">froxel 글 03장</a>에서 해부한 Light Grid를 그대로 순회한다 — 셀 헤더(<code>FCulledLightsGridHeader</code>)가 가리키는 인덱스 버퍼에서 라이트를 꺼내 감쇠×위상×세기를 더하는 구조다. 여기서는 안개 특유의 두 가지만 짚는다.
</p>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFog.usf:1052 (fog 그리드 → light grid 좌표 변환)</div><span class="kw">uint</span> GridIndex = <span class="fn">ComputeLightGridCellIndex</span>(GridCoordinate.xy * VolumetricFog.FogGridToPixelXY, SceneDepth, <span class="num">0</span>);
FCulledLightsGridHeader Header = <span class="fn">GetCulledLightsGridHeader</span>(GridIndex);

<span class="kw">uint</span> NumLights = Header.NumLights;
<span class="kw">#if</span> USE_MEGA_LIGHTS
    NumLights -= Header.NumMegaLights;   <span class="cm">// MegaLights가 맡은 라이트는 이 루프에서 제외(07장)</span>
<span class="kw">#endif</span></div>

<p style="color:var(--text2);line-height:1.85;">
첫째, <strong>두 그리드는 해상도가 다르다</strong> — 안개는 16px×64슬라이스, Light Grid는 64px×32슬라이스에 깊이 분포 계수도 다르다(32 vs 4.05). 그래서 fog froxel 좌표에 <code>FogGridToPixelXY</code>(=16)를 곱해 화면 픽셀 좌표로 돌린 뒤, Light Grid의 자체 변환(÷64, 자체 로그 슬라이싱)으로 다시 버킷팅한다. 둘째, 셀 대각선 반지름으로 <strong>역제곱 감쇠에 바이어스</strong>를 건다(<code>r.VolumetricFog.InverseSquaredLightDistanceBiasScale</code>) — 커다란 froxel 안에 라이트가 들어와 있으면 1/d²이 폭발해 한 froxel만 새하얗게 빛나는 에일리어싱이 생기기 때문이다.
</p>

<h2>합치기: 세 갈래 길이 모이는 곳</h2>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFog.usf:1149~1167 (경로 B/C 합산 + 매질 결합)</div>LightScattering += View.OneOverPreExposure * LocalShadowedLightScattering[GridCoordinate].xyz;  <span class="cm">// 경로 B</span>
<span class="kw">#if</span> USE_MEGA_LIGHTS
    LightScattering += MegaLightsVolume[GridCoordinate] * View.OneOverPreExposure;              <span class="cm">// 경로 C</span>
<span class="kw">#endif</span>

<span class="kw">float4</span> MaterialScatteringAndExtinction = VBufferA[GridCoordinate];
<span class="kw">float4</span> PreExposedScatteringAndExtinction = <span class="fn">float4</span>(
    View.PreExposure * (LightScattering * MaterialScatteringAndExtinction.xyz + MaterialEmissive),
    MaterialScatteringAndExtinction.w);   <span class="cm">// (입사광 × σs + 이미시브, σt)</span></div>

<p style="color:var(--text2);line-height:1.85;">
입사광 총합에 <strong>산란 계수 σs를 곱하는</strong> 마지막 줄이 물리적 의미의 핵심이다 — "이 지점에 이만큼 빛이 도착했고(σ 무관), 그중 매질이 시선 방향으로 산란시키는 양은 σs에 비례한다". 소광 계수는 건드리지 않고 .a에 실어 다음 패스로 넘긴다. 이 값이 08장의 temporal 블렌딩을 거쳐 <code>LightScattering</code> 텍스처에 기록된다.
</p>

<div class="callout callout-info">
<div class="callout-title">우버셰이더 폴백 — 5.8</div>
<p>LightScatteringCS의 퍼뮤테이션 축은 10개다(temporal, DFAO, Lumen GI, VSM, 레이트레이스 볼륨, 라이트펑션 아틀라스, MegaLights, soft fading, 슈퍼샘플링, 우버셰이더). 전부 컴파일하면 조합 폭발이므로, 5.8은 특화 PSO가 아직 프리캐시되지 않았으면 <strong>런타임 분기(<code>IF_UBERSHADER(b...)</code>) 하나로 모든 기능을 켜고 끄는 우버셰이더</strong>로 일단 실행하고, 특화 버전이 준비되면 갈아탄다. PSO 히치를 안개가 안 그려지는 프레임으로 때우지 않겠다는 설계다.</p>
</div>

<span class="section-eyebrow">07 — MegaLights 연동</span>
</div>

# MegaLights: 수백 개의 그림자 라이트를 안개에

<div class="vf-post">
<div class="flag-row"><span class="flag-badge flag-gold">MegaLightsVolumeSampling/RayTracing/Shading.usf</span><span class="flag-badge flag-purple">r.MegaLights.Volume.*</span></div>

<p style="color:var(--text2);line-height:1.85;">
경로 B(라이트당 한 패스)는 그림자 있는 라이트가 수십 개를 넘으면 감당이 안 된다. MegaLights가 켜져 있으면 <code>bAllowMegaLights</code>인 라이트들은 <strong>스토캐스틱 볼륨 파이프라인</strong>이 대신 맡는다. 파이프라인 자체(RIS 기반 후보 선택 → 레이 트레이싱 가시성 → resolve)는 <a href="/froxel">froxel 글 05장</a>과 MegaLights 글에서 다뤘으므로, 여기서는 안개 관점의 흐름만 요약한다.
</p>

<div class="flow-row">
<div class="flow-step">
<div class="step-num">1 — VolumeSampling</div>
<div class="step-name">후보 선택</div>
<div class="step-desc">다운샘플된 froxel(기본 2×2×2)마다 Light Grid의 MegaLights 구간에서 복셀당 2개 샘플을 RIS로 선택. 지난 프레임 가시성 해시로 가이드</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">2 — VolumeRayTracing</div>
<div class="step-name">가시성</div>
<div class="step-desc">선택된 샘플만 HW RT 또는 SDF 소프트웨어 트레이스로 월드 스페이스 그림자 레이. 스크린 트레이스는 없음</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">3 — VolumeResolve</div>
<div class="step-name">셰이딩</div>
<div class="step-desc">안개 그리드 전체 해상도의 <code>Volume.ResolvedLighting</code>(PF_FloatRGB)으로 리샘플·셰이딩</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">4 — LightScatteringCS</div>
<div class="step-name">합산</div>
<div class="step-desc"><code>LightScattering += MegaLightsVolume[coord]</code> 한 줄</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이중 계산 방지 장치가 양쪽에 있다 — Light Grid는 컬링 단계에서 MegaLights가 맡은 라이트를 셀 리스트의 <strong>꼬리 쪽에 정렬해 두고 개수(<code>NumMegaLights</code>)를 헤더에 패킹</strong>하며, 06장에서 봤듯 fog의 루프는 그만큼을 빼고 돈다. 방향광도 MegaLights가 맡았으면(<code>DirectionalLightHandledByMegaLights</code>) 인라인 방향광 계산을 건너뛴다. 흥미로운 점 하나: MegaLights의 fog 볼륨 경로에는 <strong>전용 디노이저가 없다</strong> — 스토캐스틱 노이즈의 시간축 안정화를 다음 장의 Volumetric Fog 자체 temporal reprojection에 그대로 맡긴다. 두 시스템이 지터·히스토리 인프라를 공유하는 셈이다.
</p>

<span class="section-eyebrow">08 — 시간축</span>
</div>

# Temporal Reprojection: 52만 froxel을 프레임마다 다 계산하지 않는 법

<div class="vf-post">
<div class="flag-row"><span class="flag-badge flag-gold">VolumetricFog.usf:1169</span><span class="flag-badge flag-teal">HistoryWeight 0.9</span></div>

<p style="color:var(--text2);line-height:1.85;">
06장의 계산은 froxel당 라이트 샘플 <strong>하나</strong>로 이루어진다(지터 위치 하나). 노이즈가 심할 수밖에 없는데, 이걸 지난 프레임 결과와 지수이동평균으로 섞어 수렴시킨다. 지터 시퀀스는 Halton 수열이다.
</p>

<div class="code-block"><div class="code-lang">C++ — VolumetricFog.cpp:270 (프레임 지터 생성 — Halton(2,3,5))</div><span class="ty">FVector3f</span> <span class="fn">VolumetricFogTemporalRandom</span>(<span class="ty">uint32</span> FrameNumber)
{
    <span class="cm">// TemporalAA와 다른 시퀀스를 써서 상관을 피한다</span>
    <span class="kw">return</span> <span class="ty">FVector3f</span>(<span class="fn">Halton</span>(FrameNumber &amp; <span class="num">1023</span>, <span class="num">2</span>), <span class="fn">Halton</span>(FrameNumber &amp; <span class="num">1023</span>, <span class="num">3</span>), <span class="fn">Halton</span>(FrameNumber &amp; <span class="num">1023</span>, <span class="num">5</span>));
}</div>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFog.usf:1169 (히스토리 블렌딩)</div><span class="kw">float4</span> PreExposedHistory = <span class="fn">Texture3DSampleLevel</span>(LightScatteringHistory, ..., HistoryUV, <span class="num">0</span>);
PreExposedHistory.rgb *= LightScatteringHistoryPreExposureAndInv.y * View.PreExposure;  <span class="cm">// 노출 변화 보정</span>
PreExposedScatteringAndExtinction = <span class="fn">lerp</span>(PreExposedScatteringAndExtinction, PreExposedHistory, HistoryAlpha);</div>

<p style="color:var(--text2);line-height:1.85;">
<code>HistoryAlpha</code>는 기본 0.9(<code>r.VolumetricFog.HistoryWeight</code>) — 매 프레임 새 계산이 10%씩만 반영되어 약 10프레임에 걸쳐 수렴한다. 흥미로운 설계 결정들:
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">3D 리프로젝션</div>
<div class="card-title">화면 밖 문제가 훨씬 덜하다</div>
<div class="card-desc">froxel 중심의 월드 좌표를 <strong>지난 프레임의 unjittered 행렬</strong>로 투영해 히스토리 3D UV를 얻는다. 2D TAA와 달리 깊이 방향 정보가 있어 리프로젝션 실패가 드물다 — Wronski가 2014년에 "3D에서는 리프로젝션이 훨씬 쉽다"고 지적한 그대로다. 프러스텀 밖이면 <code>HistoryAlpha=0</code>.</div>
</div>
<div class="card gold">
<div class="card-label">Conservative Depth — 5.8</div>
<div class="card-title">가려졌던 froxel의 히스토리는 버린다</div>
<div class="card-desc">02장 1번 패스가 만든 지난 프레임 최전방 깊이를 <code>Gather</code>로 읽어(<code>FixupHistoryUV</code>), <strong>지난 프레임에 불투명 뒤에 있어 계산되지 않았던 위치</strong>의 히스토리를 거부한다. 카메라가 벽을 돌 때 벽 뒤의 "죽은" 안개값이 번져 나오는 고스팅을 막는다.</div>
</div>
<div class="card teal">
<div class="card-label">History Miss 슈퍼샘플링</div>
<div class="card-title">히스토리가 없으면 그 자리에서 4배 샘플</div>
<div class="card-desc">히스토리가 거부된 froxel은 그 프레임에 한해 라이트 샘플을 4개(<code>r.VolumetricFog.HistoryMissSupersampleCount</code>)로 늘려 계산한다 — 과거 프레임 지터 오프셋들을 재사용해서. 디스오클루전 순간의 노이즈 폭발을 공간 샘플로 때운다.</div>
</div>
<div class="card coral">
<div class="card-label">무엇을 히스토리로 남기나</div>
<div class="card-title">적분 전 텍스처다</div>
<div class="card-desc">히스토리로 추출되는 것은 <code>IntegratedLightScattering</code>이 아니라 <strong>적분 전의 <code>LightScattering</code></strong>이다. 누적 적분값은 카메라가 움직이면 froxel마다 의미가 달라져 재사용할 수 없지만, "그 지점의 국소 산란광"은 월드에 붙어 있는 값이라 리프로젝션이 성립한다. 소광(.a)은 리프로젝션하지 않는다.</div>
</div>
</div>

<span class="section-eyebrow">09 — 적분</span>
</div>

# FinalIntegrationCS: Beer-Lambert를 제대로 적분하기

<div class="vf-post">
<div class="flag-row"><span class="flag-badge flag-gold">VolumetricFog.usf — FinalIntegrationCS</span><span class="flag-badge flag-teal">8×8×1 threadgroup</span></div>

<p style="color:var(--text2);line-height:1.85;">
마지막 컴퓨트 패스는 XY 컬럼마다 스레드 하나를 배정하고(그래서 그룹이 8×8×<strong>1</strong>이다), 카메라에서 먼 쪽으로 64개 슬라이스를 순서대로 걸으며 누적한다. 루프 코드는 <a href="/froxel">froxel 글 04장</a>에서 이미 인용했으니, 이번에는 그 코드의 <strong>수학이 왜 그 모양인지</strong>를 보자.
</p>

<p style="color:var(--text2);line-height:1.85;">
슬라이스 하나(두께 D, 산란광 S, 소광 σt — 슬라이스 안에서 상수라고 가정)가 카메라로 보내는 빛을 생각한다. 순진한 답은 <code>S × D</code>("산란광 × 두께")다. 하지만 슬라이스 <strong>안쪽 깊이 x에서 산란된 빛은 슬라이스 앞면까지 나오는 동안 자기 매질에 또 감쇠된다</strong>. 이걸 반영하면:
</p>

<div class="formula">∫₀ᴰ S · e^(−σt·x) dx  =  S · (1 − e^(−σt·D)) / σt  =  (S − S·T) / σt     (T = e^(−σt·D))</div>

<p style="color:var(--text2);line-height:1.85;">
σt가 작으면 테일러 전개로 <code>S·D</code>에 수렴하므로 옅은 안개에서는 두 식이 같다. 그러나 짙은 안개에서는 순진한 식이 <strong>슬라이스 뒤쪽에서 빠져나오지 못하는 빛까지 세어 에너지를 초과</strong>한다 — 밀도를 올릴수록 안개가 물리보다 밝아지는 버그가 된다. 해석적 형태를 쓰면 슬라이스를 아무리 굵게 잘라도 에너지가 보존된다. UE 코드의 주석이 인용하는 Frostbite(Hillaire, SIGGRAPH 2015)의 "energy-conserving integration"이 바로 이 식이다.
</p>

<div class="code-block"><div class="code-lang">HLSL — VolumetricFog.usf:1219 (적분 루프 — 수학이 코드가 되는 지점)</div><span class="kw">for</span> (<span class="kw">int</span> LayerIndex = <span class="num">0</span>; LayerIndex &lt; ViewGridSizeInt.z; LayerIndex++)
{
    <span class="kw">float4</span> ScatteringAndExtinction = LightScattering[<span class="fn">uint3</span>(GridCoordinate.xy, LayerIndex)];
    <span class="kw">float</span> StepLength = <span class="fn">length</span>(LayerTranslatedWorldPosition - PreviousSliceTranslatedWorldPosition);

    <span class="kw">float</span> Transmittance = <span class="fn">exp</span>(-ScatteringAndExtinction.w * StepLength);            <span class="cm">// T = e^(−σt·D)</span>

    <span class="kw">float3</span> ScatteringIntegratedOverSlice =                                          <span class="cm">// (S − S·T)/σt</span>
        (ScatteringAndExtinction.rgb - ScatteringAndExtinction.rgb * Transmittance)
        / <span class="fn">max</span>(ScatteringAndExtinction.w, <span class="num">.00001f</span>);

    AccumulatedLighting += ScatteringIntegratedOverSlice * AccumulatedTransmittance; <span class="cm">// 앞쪽 가림 반영</span>
    AccumulatedTransmittance *= Transmittance;

    RWIntegratedLightScattering[LayerCoordinate] = <span class="fn">float4</span>(AccumulatedLighting, AccumulatedTransmittance);
}</div>

<p style="color:var(--text2);line-height:1.85;">
슬라이스의 산란 기여에는 <strong>지금까지의 누적 투과율</strong>이 곱해진다(먼 슬라이스의 빛은 앞쪽 안개에 또 가려지니까). 그리고 <strong>매 슬라이스마다 중간 결과를 기록</strong>하는 것이 핵심이다 — 그래서 임의의 깊이 d에 있는 표면은 자기 앞 구간만큼의 안개를 텍스처 좌표 z로 골라 읽을 수 있다. 실제 코드에는 여기에 <code>VolumetricFogNearFadeInDistanceInv</code>에 의한 근거리 페이드인 계수가 산란과 투과율 양쪽에 걸려 있다(카메라 코앞의 안개를 부드럽게 죽이는 아티스트 컨트롤).
</p>

<span class="section-eyebrow">10 — 합성</span>
</div>

# 씬에 입히기: 룩업 한 번, 공식 한 줄

<div class="vf-post">
<div class="flag-row"><span class="flag-badge flag-gold">HeightFogCommon.ush — CombineVolumetricFog</span><span class="flag-badge flag-blue">FogRendering.cpp</span></div>

<p style="color:var(--text2);line-height:1.85;">
<code>IntegratedLightScattering</code>은 Fog 유니폼 버퍼에 실려(<code>FogRendering.cpp:186</code>) 높이안개 픽셀 셰이더, 반투명 렌더링, 파티클 등 안개가 필요한 모든 곳에서 샘플링된다. 픽셀의 화면 UV와 깊이로 3D UV를 만들고(깊이→슬라이스는 같은 로그 공식), 룩업 결과를 분석적 높이안개와 결합한다.
</p>

<div class="code-block"><div class="code-lang">HLSL — HeightFogCommon.ush:535 (CombineVolumetricFog, 요지)</div><span class="kw">float4</span> VolumetricFogLookup = <span class="fn">SampleVolumetricFogFiltered</span>(VolumeUV);   <span class="cm">// 품질에 따라 trilinear/bicubic/tricubic</span>
VolumetricFogLookup.rgb *= InView.OneOverPreExposure;

<span class="cm">// (누적 산란광 + 분석 높이안개 × 볼륨 투과율, 볼륨 투과율 × 높이안개 투과율)</span>
<span class="kw">return</span> <span class="fn">float4</span>(VolumetricFogLookup.rgb + GlobalFog.rgb * VolumetricFogLookup.a,
              VolumetricFogLookup.a * GlobalFog.a);</div>

<p style="color:var(--text2);line-height:1.85;">
최종 화면색은 <code>SceneColor × Fog.a + Fog.rgb</code>가 된다 — 투과율이 씬을 감쇠시키고 산란광이 더해지는, 01장 물리 그대로의 합성이다. 볼륨이 커버하는 <code>VolumetricFogDistance</code>(기본 6000cm) 너머는 분석적 높이안개가 이어받는데, <code>CalculateHeightFog</code>가 froxel 볼륨의 끝 거리만큼을 <strong>분석 적분에서 제외</strong>(<code>ExcludeDistance</code>)해 이중 적용을 막는다. 업샘플 시 froxel 경계 계단이 보이지 않도록 룩업 UV에도 지터(<code>r.VolumetricFog.UpsampleJitterMultiplier</code>)가 들어가고, <code>r.VolumetricFog.Filtering.Quality</code>로 트라이리니어/바이큐빅/트라이큐빅 필터를 고를 수 있다.
</p>

<span class="section-eyebrow">11 — 튜닝</span>
</div>

# CVar 지도: 어느 단계에 무엇이 꽂히는가

<div class="vf-post">
<div class="data-table">
<table>
<thead><tr><th>CVar</th><th>기본값</th><th>단계</th><th>의미</th></tr></thead>
<tbody>
<tr><td><code>r.VolumetricFog</code></td><td>1</td><td>전체</td><td>마스터 스위치</td></tr>
<tr><td><code>r.VolumetricFog.GridPixelSize</code></td><td>16</td><td>그리드</td><td>froxel 타일 크기. 8로 줄이면 XY 해상도 4배(비용도 4배)</td></tr>
<tr><td><code>r.VolumetricFog.GridSizeZ</code></td><td>64</td><td>그리드</td><td>깊이 슬라이스 수. 그림자 줄기의 깊이 정밀도</td></tr>
<tr><td><code>r.VolumetricFog.DepthDistributionScale</code></td><td>32.0</td><td>그리드</td><td>로그 깊이 분포의 기울기. 클수록 근거리에 슬라이스 집중</td></tr>
<tr><td><code>r.VolumetricFog.Emissive</code></td><td>1</td><td>MaterialSetup</td><td>VBufferB(이미시브) 할당 여부</td></tr>
<tr><td><code>r.VolumetricFog.InjectShadowedLightsSeparately</code></td><td>1</td><td>경로 B</td><td>그림자 로컬 라이트의 라이트별 주입 패스</td></tr>
<tr><td><code>r.VolumetricFog.InverseSquaredLightDistanceBiasScale</code></td><td>1.0</td><td>LightScattering</td><td>froxel 내부 라이트의 역제곱 폭발 방지 바이어스</td></tr>
<tr><td><code>r.VolumetricFog.TemporalReprojection</code></td><td>1</td><td>시간축</td><td>히스토리 블렌딩 여부</td></tr>
<tr><td><code>r.VolumetricFog.Jitter</code></td><td>1</td><td>시간축</td><td>Halton 프레임 지터 여부</td></tr>
<tr><td><code>r.VolumetricFog.HistoryWeight</code></td><td>0.9</td><td>시간축</td><td>히스토리 비중 — 지터링 대 반응성의 트레이드오프</td></tr>
<tr><td><code>r.VolumetricFog.HistoryMissSupersampleCount</code></td><td>4</td><td>시간축</td><td>히스토리 거부 froxel의 당(當)프레임 샘플 수</td></tr>
<tr><td><code>r.VolumetricFog.ConservativeDepth</code></td><td>1</td><td>시간축/컬링</td><td>최전방 깊이 텍스처 — froxel 스킵 + 히스토리 거부</td></tr>
<tr><td><code>r.VolumetricFog.InjectRaytracedLights</code></td><td>0</td><td>경로 B</td><td>방향광 레이트레이스 그림자 볼륨(고비용, 기본 꺼짐)</td></tr>
<tr><td><code>r.VolumetricFog.Filtering.Quality</code></td><td>—</td><td>합성</td><td>0/1/2 = trilinear / bicubic / tricubic</td></tr>
<tr><td><code>r.MegaLights.Volume</code></td><td>1</td><td>경로 C</td><td>MegaLights 안개 볼륨 파이프라인</td></tr>
<tr><td><code>r.MegaLights.Volume.NumSamplesPerVoxel</code></td><td>2</td><td>경로 C</td><td>복셀당 스토캐스틱 라이트 샘플 수</td></tr>
</tbody>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
CVar가 아닌 것들 — 안개의 물성(Albedo, ExtinctionScale, ScatteringDistribution=PhaseG, Emissive)과 범위(VolumetricFogDistance, StartDistance, NearFadeInDistance), 정적 라이팅 반영(StaticLightingScatteringIntensity), 그리고 라이트별 <code>VolumetricScatteringIntensity</code>(0으로 두면 그 라이트는 안개에서 제외)는 전부 Exponential Height Fog 컴포넌트와 라이트 컴포넌트의 에디터 프로퍼티다.
</p>

<span class="section-eyebrow">12 — 정리</span>
</div>

# 정리

<div class="vf-post">
<p style="color:var(--text2);line-height:1.85;">
Volumetric Fog 파이프라인을 한 문장으로 압축하면 — <strong>"참여 매질 렌더링 방정식을 froxel 그리드 위에서 분리·이산화하고, 노이즈는 시간축에 떠넘긴다"</strong>이다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">분리 ①</div>
<div class="card-title">매질과 빛의 분리</div>
<div class="card-desc">매질(VBufferA/B — MaterialSetup·복셀화)과 입사광(LightScattering)과 적분(IntegratedLightScattering)을 서로 다른 패스로 나눴다. 그래서 볼륨 머티리얼은 라이팅을 몰라도 되고, 라이팅은 매질의 출처를 몰라도 된다.</div>
</div>
<div class="card gold">
<div class="card-label">분리 ②</div>
<div class="card-title">라이트의 세 갈래 분리</div>
<div class="card-desc">인라인(방향광+그림자 없는 로컬), 라이트별 래스터 주입(그림자 로컬), MegaLights(스토캐스틱 대량)로 나눠, 각 경로가 자기에게 맞는 자료구조와 가시성 기법을 쓴다.</div>
</div>
<div class="card teal">
<div class="card-label">이산화</div>
<div class="card-title">해석적 조각 적분</div>
<div class="card-desc">64개 슬라이스로 자르되 각 슬라이스는 (S−S·T)/σt 해석해로 적분해 에너지를 보존한다. 슬라이스가 굵어도 밝기가 새지 않는 이유.</div>
</div>
<div class="card coral">
<div class="card-label">시간축</div>
<div class="card-title">1샘플 + 지터 + 히스토리</div>
<div class="card-desc">froxel당 프레임당 라이트 샘플은 하나뿐. Halton 지터와 90% 히스토리 블렌딩, conservative depth 기반 히스토리 거부가 그 하나를 수십 샘플처럼 보이게 만든다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
2014년 Wronski가 Assassin's Creed 4에서 제시한 구조(프러스텀 정렬 3D 텍스처 + 지수 깊이 분포 + temporal 지터/리프로젝션 제안)와 2015년 Hillaire가 Frostbite에서 완성한 물리 기반 정식화(froxel이라는 이름, energy-conserving 적분)가, 십 년이 지난 UE 5.8 소스에 거의 원형 그대로 — 다만 VSM·Lumen GI·MegaLights·conservative depth 같은 동시대 시스템들과 촘촘히 엮인 채로 — 살아 있다. 관련 자료구조가 더 궁금하다면 <a href="/froxel">froxel 글</a>에서 Light Grid의 패킹 포맷과 UE5.8의 새 Sparse Froxel 시스템을, 스토캐스틱 라이팅이 궁금하다면 MegaLights 글을 이어 읽으면 된다.
</p>
</div>
