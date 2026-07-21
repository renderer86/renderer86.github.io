---
layout: post
title: "Spherical Harmonics: 라이팅을 float 9개로 압축하는 법 — SH 기저의 (N+1)² 유도부터 UE5.8의 irradiance·directionality까지"
icon: paper
permalink: spherical-harmonics
categories: Rendering
tags: [ComputerGraphics, Rendering, UnrealEngine, SphericalHarmonics, GlobalIllumination, Lighting, Irradiance, PRT]
excerpt: "구면 위의 라이팅 함수를 소수의 실수로 압축하는 도구가 Spherical Harmonics(SH)다. 이 글은 UE 5.8 소스를 코드로 끝까지 추적한다 — 왜 order N까지 쓰면 계수가 정확히 (N+1)²개이고 SH3이 float 9개(RGB 27개)인지의 유도, SHMath.cpp가 sqrt((2l+1)/4π·(l-|m|)!/(l+|m|)!)로 굽는 정규화 상수, 그리고 Ramamoorthi-Hanrahan이 증명한 '디퓨즈 irradiance는 9계수·평균 오차 1%'라는 압축의 근거. 클램프 코사인 컨볼루션의 밴드 계수 π·2π/3·π/4가 CalcDiffuseTransfer의 L0·L1·L2로 그대로 살아있고, 셰이딩은 DotSH3 한 번의 내적으로 끝난다. SH directionality(l=1 밴드에서 뽑는 지배 방향, GetMaximumDirection)와 volumetric lightmap·skylight·ILC·Lumen의 실제 저장 방식, 그리고 Gibbs 링잉을 죽이는 windowing까지 정리한다."
back_color: "#ffffff"
img_name: "spherical-harmonics-core-sketch.png"
toc: false
show: true
new: true
series: -1
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 라이트 프로브나 스카이라이트가 "float 9개"에 무엇을 어떻게 담는지, 왜 하필 9개인지 궁금한 분
> - SH3 기준 계수가 정확히 9개(RGB면 27개)로 떨어지는 이유를 (N+1)² 유도로 딱 떨어지게 보고 싶은 분
> - `0.282095`, `0.488603`, `1.092548` 같은 셰이더 매직 넘버가 어느 정규화 상수에서 나오는지 알고 싶은 분
> - 왜 방향별로 값이 필요한 큐브맵 대신 SH 9계수로 "충분"한지 — 압축이 성립하는 수학적 근거가 필요한 분
> - "SH directionality", 즉 SH에서 지배적 광원 방향을 뽑는다는 게 정확히 무엇이고 UE가 이걸 어디에 쓰는지 궁금한 분
> - 볼류메트릭 라이트맵 · 스카이라이트 · ILC · Lumen이 각각 SH를 몇 밴드로, 어떤 포맷으로 저장하는지 코드로 확인하고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - 구면 위의 함수를 기저로 분해(projection)하고 다시 합성(reconstruction)하는 SH의 기본 구조와, 푸리에 급수와의 관계
> - band `l`마다 기저가 `2l+1`개라서 `Σ(2l+1)=(N+1)²` — order 3에서 정확히 9개가 되는 유도, 그리고 UE `SHGetBasisIndex`의 `l(l+1)+m` 인덱싱
> - `SHMath.cpp`의 `NormalizationConstants`가 `√((2l+1)/4π · (l-|m|)!/(l+|m|)!)`로 계산되고, Legendre 다항식과 곱해져 기저값이 완성되는 과정
> - Ramamoorthi & Hanrahan 2001의 핵심 결과 — 디퓨즈 irradiance는 저주파라서 9계수로 평균 오차 1%, 필터 에너지의 99.2%가 밴드 0~2에 몰림
> - 클램프 코사인 커널의 밴드 계수 `Â_0=π, Â_1=2π/3, Â_2=π/4`가 `CalcDiffuseTransfer`의 `L0/L1/L2`로 그대로 코딩된 것
> - 디퓨즈 셰이딩이 `DotSH3(Irradiance, DiffuseTransfer)` 내적 한 번으로 끝나는 이유 (PRT의 전달 벡터)
> - `GetMaximumDirection`이 `l=1` 밴드 3개 계수로 지배 방향을 복원하는 근사, 그리고 capsule shadow가 이를 소비하는 코드
> - 볼류메트릭 라이트맵(DC + 6계수 텍스처), 스카이라이트(7×float4 팩), ILC(2/3밴드), Lumen(radiance/irradiance SH)의 실제 저장 레이아웃
> - Gibbs 링잉과 `ApplyWindowing`/`FindWindowingLambda`의 디링잉 — "Stupid SH Tricks"가 코드에 남긴 흔적

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.sh-post {
  --bg2: #eef2fb;
  --surface: #f6f8fd;
  --surface2: #e9eef7;
  --border: rgba(37,99,235,0.12);
  --border2: rgba(37,99,235,0.26);
  --text: #141a26;
  --text2: #3f4757;
  --text3: #7d8698;
  --accent: #2563eb;
  --accent2: #7c3aed;
  --gold: #b07d00;
  --teal: #0a8f72;
  --coral: #d6304a;
}
.sh-post .section-eyebrow {
  display: block;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin-bottom: 4px;
  margin-top: 56px;
}
.sh-post .card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
  margin: 24px 0;
}
.sh-post .card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  position: relative;
  overflow: hidden;
}
.sh-post .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
}
.sh-post .card.blue::before   { background: var(--accent); }
.sh-post .card.purple::before { background: var(--accent2); }
.sh-post .card.gold::before   { background: var(--gold); }
.sh-post .card.teal::before   { background: var(--teal); }
.sh-post .card.coral::before  { background: var(--coral); }
.sh-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.sh-post .card.blue   .card-label { color: var(--accent); }
.sh-post .card.purple .card-label { color: var(--accent2); }
.sh-post .card.gold   .card-label { color: var(--gold); }
.sh-post .card.teal   .card-label { color: var(--teal); }
.sh-post .card.coral  .card-label { color: var(--coral); }
.sh-post .card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 6px;
}
.sh-post .card-desc {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.65;
  margin: 0;
}
.sh-post .callout {
  border-radius: 12px;
  padding: 16px 20px;
  margin: 20px 0;
  border: 1px solid;
  position: relative;
  overflow: hidden;
}
.sh-post .callout::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
}
.sh-post .callout-info { background: rgba(37,99,235,0.05); border-color: rgba(37,99,235,0.18); }
.sh-post .callout-info::before { background: var(--accent); }
.sh-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); }
.sh-post .callout-warn::before { background: var(--gold); }
.sh-post .callout-purple { background: rgba(124,58,237,0.05); border-color: rgba(124,58,237,0.20); }
.sh-post .callout-purple::before { background: var(--accent2); }
.sh-post .callout-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.sh-post .callout-info .callout-title { color: var(--accent); }
.sh-post .callout-warn .callout-title { color: var(--gold); }
.sh-post .callout-purple .callout-title { color: var(--accent2); }
.sh-post .callout p { margin: 0 0 8px 0; font-size: 13px; color: var(--text2); line-height: 1.75; }
.sh-post .callout p:last-child { margin: 0; }
.sh-post .code-block {
  background: #171a2e;
  border: 1px solid rgba(129,140,248,0.15);
  border-radius: 12px;
  padding: 20px 22px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.85;
  overflow-x: auto;
  margin: 18px 0;
  position: relative;
  white-space: pre;
  color: #cdd3ea;
}
.sh-post .code-block .kw  { color: #a5b4fc; }
.sh-post .code-block .fn  { color: #93c5fd; }
.sh-post .code-block .cm  { color: #6b7391; font-style: italic; }
.sh-post .code-block .num { color: #fb923c; }
.sh-post .code-block .str { color: #fbbf24; }
.sh-post .code-block .ty  { color: #67e8f9; }
.sh-post .code-lang {
  position: absolute;
  top: 10px; right: 14px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #6b7391;
}
.sh-post .flow-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 24px 0;
  overflow-x: auto;
}
.sh-post .flow-step {
  flex: 1;
  min-width: 116px;
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 14px 16px;
  position: relative;
  text-align: center;
}
.sh-post .flow-step .step-num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 4px;
}
.sh-post .flow-step .step-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}
.sh-post .flow-step .step-desc {
  font-size: 11px;
  color: var(--text2);
  line-height: 1.5;
}
.sh-post .flow-arrow {
  display: flex;
  align-items: center;
  padding: 0 6px;
  color: var(--text3);
  font-size: 18px;
  flex-shrink: 0;
}
.sh-post .flag-badge {
  display: inline-block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 5px;
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.sh-post .flag-coral  { background: rgba(214,48,73,0.12);  color: var(--coral); }
.sh-post .flag-blue   { background: rgba(37,99,235,0.12);  color: var(--accent); }
.sh-post .flag-teal   { background: rgba(10,143,114,0.12); color: var(--teal); }
.sh-post .flag-gold   { background: rgba(176,125,0,0.12);  color: var(--gold); }
.sh-post .flag-purple { background: rgba(124,58,237,0.12); color: var(--accent2); }
.sh-post .flag-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 14px; }
.sh-post .data-table { overflow-x: auto; margin: 24px 0; }
.sh-post .data-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
.sh-post .data-table th {
  padding: 10px 14px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--accent);
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; text-align: left;
}
.sh-post .data-table td { padding: 9px 14px; border: 1px solid var(--border); color: var(--text2); }
.sh-post .data-table tr:nth-child(even) td { background: var(--surface); }
.sh-post .data-table code { font-size: 12px; }
.sh-post .formula {
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
.sh-post .sh-pyramid {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: 24px 0;
}
.sh-post .sh-pyramid .band-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.sh-post .sh-pyramid .band-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text3);
  width: 64px;
  text-align: right;
}
.sh-post .sh-pyramid .lobe {
  width: 34px; height: 34px;
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px; font-weight: 600;
  color: #fff;
}
.sh-post .sh-pyramid .lobe.l0 { background: var(--accent); }
.sh-post .sh-pyramid .lobe.l1 { background: var(--accent2); }
.sh-post .sh-pyramid .lobe.l2 { background: var(--teal); }
</style>

<div class="sh-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: 구면 위의 라이팅을 실수 몇 개로 접는 문제

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
한 점을 셰이딩하려면 그 점을 덮는 반구 전체에서 들어오는 빛을 알아야 한다. 이 "방향마다 다른 빛"을 그대로 저장하려면 <strong>큐브맵</strong>처럼 방향을 촘촘히 샘플링한 텍스처가 필요하다. 6면 × 예컨대 16×16이면 방향당 하나씩 <strong>수천 개의 값</strong>이다. 그런데 씬 곳곳에 라이트 프로브를 수천 개 박아야 하는 상황에서 프로브 하나당 큐브맵 한 장은 감당이 안 된다. 메모리도, 대역폭도.
</p>

<p style="color:var(--text2);line-height:1.85;">
여기서 결정적인 관찰이 하나 있다. <strong>디퓨즈(램버시안) 표면이 반사하는 빛은 방향에 대해 매우 "부드러운" 함수</strong>다. 표면은 반구 전체의 빛을 코사인 가중으로 뭉개서 받기 때문에, 조명이 아무리 뾰족해도 그 결과(irradiance)는 완만하게 번진다. 부드러운 함수라면 고주파 성분이 거의 없고, 고주파가 없으면 <strong>몇 개의 저주파 계수만으로 거의 완벽하게 재구성</strong>할 수 있다. 이 발상을 구(sphere) 위에서 정확히 실현하는 도구가 <strong>Spherical Harmonics(구면 조화 함수, SH)</strong>다.
</p>

<p style="color:var(--text2);line-height:1.85;">
SH는 "구면 위의 푸리에 급수"다. 1차원 신호를 사인·코사인의 합으로 쪼개듯, 구면 위의 함수를 <strong>SH 기저함수의 가중합</strong>으로 쪼갠다. 낮은 밴드는 완만한 성분, 높은 밴드는 뾰족한 성분을 담당한다. 디퓨즈 라이팅처럼 부드러운 함수는 낮은 밴드 몇 개로 잘린다. 그 "몇 개"가 유명한 <strong>9개</strong>(3밴드, RGB면 27개)다. 이 글의 목표는 세 가지다 — (1) 왜 하필 9개인지 유도하고, (2) 왜 9개로 "압축"이 성립하는지(Ramamoorthi-Hanrahan) 근거를 대고, (3) 언리얼 엔진 5.8이 이 이론을 코드의 어떤 상수·함수로 구현해 두었는지 끝까지 추적한다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>1차 출처는 로컬 <strong>Unreal Engine 5.8</strong> 소스다 — CPU 측 <code>Engine/Source/Runtime/Core/Public/Math/SHMath.h</code>·<code>Private/Math/SHMath.cpp</code>, GPU 측 <code>Engine/Shaders/Private/SHCommon.ush</code>, 그리고 실사용처 <code>VolumetricLightmapShared.ush</code>·<code>ReflectionEnvironmentShared.ush</code>·<code>BasePassPixelShader.usf</code>·<code>Lumen/*</code>·<code>CapsuleShadowShaders.usf</code>를 직접 읽고 정리했다. 이론 배경과 수치는 <strong>Ramamoorthi & Hanrahan, "An Efficient Representation for Irradiance Environment Maps" (SIGGRAPH 2001)</strong>, <strong>Sloan, Kautz & Snyder, "Precomputed Radiance Transfer" (SIGGRAPH 2002)</strong>, <strong>Peter-Pike Sloan, "Stupid Spherical Harmonics (SH) Tricks" (GDC 2008)</strong>에 근거했으며, 인용한 오차·계수 값은 해당 논문에서 검증했다.</p>
</div>

<span class="section-eyebrow">01 — 기저로 분해하기</span>
</div>

# 구면 위의 함수를 "기저"로 쪼갠다

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
푸리에 급수를 떠올리자. 주기 함수 <code>f(x)</code>는 서로 직교하는 사인·코사인의 가중합으로 표현된다. 각 계수는 <code>f</code>에 그 기저를 곱해 적분하면 얻어진다(projection). 다시 계수에 기저를 곱해 더하면 원 함수가 복원된다(reconstruction). SH는 이 구조를 <strong>구면 <code>S²</code> 위의 함수</strong>로 옮긴 것이다. 정의역이 실수 구간이 아니라 방향 벡터(단위 구)일 뿐, 골격은 동일하다.
</p>

<p style="color:var(--text2);line-height:1.85;">
구면 위의 함수 <code>f(ω)</code>(<code>ω</code>는 방향)를 SH 기저 <code>y_l^m(ω)</code>로 사영하면 계수 <code>c_l^m</code>이 나오고, 그 계수들로 다시 함수를 근사한다.
</p>

<div class="formula">projection   c_l^m = ∫_{S²} f(ω) · y_l^m(ω) dω        (구면 전체 적분)

reconstruct  f(ω) ≈ Σ_l Σ_{m=-l..l} c_l^m · y_l^m(ω)     (l = 0 .. N-1)</div>

<p style="color:var(--text2);line-height:1.85;">
여기서 <code>l</code>은 <strong>밴드(band, degree)</strong>, <code>m</code>은 그 밴드 안의 <strong>차수(order)</strong>다. 밴드 <code>l</code>이 커질수록 그 기저함수는 구면 위에서 더 빠르게 진동한다 — 즉 더 높은 주파수를 담당한다. <code>l=0</code>은 구면 전체에서 상수(=평균값, DC 성분), <code>l=1</code>은 한 축을 따라 완만하게 기우는 성분, <code>l=2</code>는 조금 더 복잡한 두 번 진동하는 성분… 이런 식이다. <strong>낮은 밴드에서 잘라내면(truncation) 저주파 근사</strong>가 되고, 이것이 압축의 원리다.
</p>

<p style="color:var(--text2);line-height:1.85;">
SH 기저의 결정적 성질은 <strong>정규직교성(orthonormality)</strong>이다. 서로 다른 기저를 곱해 구면 적분하면 0, 같은 기저끼리는 1이 된다. 이 성질 덕분에 두 함수 <code>f, g</code>를 SH 계수로 표현했을 때, <strong>둘의 구면 위 곱적분이 계수 벡터의 단순 내적</strong>으로 떨어진다.
</p>

<div class="formula">∫_{S²} f(ω) g(ω) dω  =  Σ_i (f의 계수)_i · (g의 계수)_i   =  dot(F, G)</div>

<p style="color:var(--text2);line-height:1.85;">
이 한 줄이 SH가 실시간 렌더링에서 사랑받는 이유의 절반이다. "반구에서 빛을 적분한다"는 비싼 연산이, 두 SH 벡터의 <strong>내적 한 번</strong>으로 바뀐다(→ 05장). 나머지 절반은 "몇 개면 충분하냐"인데, 그 답이 다음 장이다.
</p>

<span class="section-eyebrow">02 — 왜 (N+1)²개인가</span>
</div>

# 밴드마다 2l+1개, 그래서 9개

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
SH의 핵심 사실 하나 — <strong>밴드 <code>l</code>에는 정확히 <code>2l+1</code>개의 기저함수가 있다</strong>. 차수 <code>m</code>이 <code>-l</code>부터 <code>+l</code>까지 정수로 움직이기 때문이다. <code>l=0</code>이면 <code>m=0</code> 하나, <code>l=1</code>이면 <code>m∈{-1,0,1}</code>로 셋, <code>l=2</code>이면 <code>m∈{-2,-1,0,1,2}</code>로 다섯. 그래서 order <code>N</code>까지(즉 <code>l = 0, 1, …, N-1</code>) 쓰면 계수의 총 개수는 등차수열의 합이다.
</p>

<div class="formula">밴드 l의 기저 개수 = 2l + 1

order N (l = 0 .. N-1) 총합:
  Σ_{l=0}^{N-1} (2l + 1) = N²

l_max 까지 (l = 0 .. l_max) 로 세면:
  Σ_{l=0}^{l_max} (2l + 1) = (l_max + 1)²</div>

<p style="color:var(--text2);line-height:1.85;">
표기 주의: "order <code>N</code>"과 "최대 밴드 <code>l_max</code>"는 <code>N = l_max + 1</code> 관계다. 어느 쪽으로 세든 결과는 <strong>완전제곱수</strong>다. 그래서 자주 쓰는 값들이 이렇게 떨어진다.
</p>

<div class="sh-pyramid">
<div class="band-row"><span class="band-tag">l = 0</span><span class="lobe l0">0</span></div>
<div class="band-row"><span class="band-tag">l = 1</span><span class="lobe l1">-1</span><span class="lobe l1">0</span><span class="lobe l1">+1</span></div>
<div class="band-row"><span class="band-tag">l = 2</span><span class="lobe l2">-2</span><span class="lobe l2">-1</span><span class="lobe l2">0</span><span class="lobe l2">+1</span><span class="lobe l2">+2</span></div>
</div>

<div class="data-table">
<table>
<tr><th>이름</th><th>밴드</th><th>계수 개수</th><th>RGB (×3)</th><th>UE 타입</th></tr>
<tr><td>SH1 (1밴드)</td><td>l=0</td><td>1² = <strong>1</strong></td><td>3</td><td><code>FOneBandSHVector</code></td></tr>
<tr><td>SH2 (2밴드)</td><td>l≤1</td><td>2² = <strong>4</strong></td><td>12</td><td><code>FSHVector2</code> / <code>FTwoBandSHVector</code></td></tr>
<tr><td>SH3 (3밴드)</td><td>l≤2</td><td>3² = <strong>9</strong></td><td>27</td><td><code>FSHVector3</code> / <code>FThreeBandSHVector</code></td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
바로 여기서 그 유명한 <strong>"float 9개"</strong>가 나온다. 밴드 3개(l=0,1,2)까지 자르면 <code>1 + 3 + 5 = 9</code>. 컬러라면 R·G·B 각각 9개씩 27개. UE는 이 개수를 타입 이름에 그대로 박아 두었다. <code>SHMath.h</code>에서 <code>TSHVector&lt;Order&gt;</code>의 계수 개수는 <code>MaxSHBasis = Order × Order</code>로 정의되고, <code>FSHVector3 = TSHVector&lt;3&gt;</code>이니 9개다.
</p>

<div class="code-block"><div class="code-lang">C++ — SHMath.h</div><span class="cm">// 밴드 (L,M) → 선형 인덱스. i = L(L+1) + M</span>
<span class="kw">UE_FORCEINLINE_HINT</span> <span class="ty">int32</span> <span class="fn">SHGetBasisIndex</span>(<span class="ty">int32</span> L, <span class="ty">int32</span> M)
{
    <span class="kw">return</span> L * (L + <span class="num">1</span>) + M;   <span class="cm">// l=0→0, l=1→{1,2,3}, l=2→{4..8}</span>
}

<span class="kw">template</span>&lt;<span class="ty">int32</span> Order&gt; <span class="kw">class</span> <span class="ty">TSHVector</span>
{
    <span class="kw">enum</span> { MaxSHOrder = Order };
    <span class="kw">enum</span> { MaxSHBasis = MaxSHOrder * MaxSHOrder };   <span class="cm">// 3×3 = 9</span>
    <span class="kw">enum</span> { NumComponentsPerSIMDVector = <span class="num">4</span> };
    <span class="kw">enum</span> { NumSIMDVectors = (MaxSHBasis + <span class="num">3</span>) / <span class="num">4</span> };  <span class="cm">// ceil(9/4) = 3</span>
    <span class="kw">enum</span> { NumTotalFloats = NumSIMDVectors * <span class="num">4</span> };    <span class="cm">// 12 (9 유효 + 3 패딩)</span>
    <span class="ty">float</span> V[NumTotalFloats];
};
<span class="kw">typedef</span> <span class="ty">TSHVector</span>&lt;<span class="num">3</span>&gt; FSHVector3;   <span class="cm">// 9 계수</span>
<span class="kw">typedef</span> <span class="ty">TSHVector</span>&lt;<span class="num">2</span>&gt; FSHVector2;   <span class="cm">// 4 계수</span></div>

<p style="color:var(--text2);line-height:1.85;">
인덱스 공식 <code>L*(L+1)+M</code>은 논문의 표준 관례 <code>i = l(l+1)+m</code> 그대로다. 눈여겨볼 디테일 하나 — 계수는 9개지만 <strong>실제 메모리는 12 float</strong>다. SIMD(4-wide) 정렬을 위해 9를 4의 배수인 12로 올림했다. 9개를 <code>float4</code> 세 덩어리로 처리하면 로드·곱·덧셈이 벡터 명령 세 번에 끝나기 때문이다. 낭비되는 3 float은 0으로 채워져 내적에 영향이 없다.
</p>

<span class="section-eyebrow">03 — 기저값의 정체</span>
</div>

# 0.282095는 어디서 왔나: 정규화 상수 × Legendre

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
SH 셰이더 코드에는 <code>0.282095</code>, <code>0.488603</code>, <code>1.092548</code> 같은 정체불명의 상수가 박혀 있다. 이들은 임의의 매직 넘버가 아니라 <strong>실수형 SH 기저함수의 닫힌 형태(closed form)</strong>다. 실수 SH 기저는 두 조각의 곱이다 — 방향에 무관한 <strong>정규화 상수 <code>K_l^m</code></strong>과, 극각(θ)·방위각(φ)에 의존하는 <strong>버금 르장드르 다항식(associated Legendre polynomial) <code>P_l^m</code></strong> 및 삼각함수. UE는 정규화 상수를 프로그램 시작 시 테이블로 한 번 구워 둔다.
</p>

<div class="code-block"><div class="code-lang">C++ — SHMath.cpp (InitSHTables)</div><span class="cm">// 9개 기저 각각의 정규화 상수를 계산해 테이블에 저장</span>
NormalizationConstants[BasisIndex] = <span class="fn">Sqrt</span>(
    (<span class="ty">float</span>(<span class="num">2</span>*L + <span class="num">1</span>) / <span class="ty">float</span>(<span class="num">4</span>*PI)) *
    (<span class="ty">float</span>(<span class="fn">Factorial</span>(L - <span class="fn">Abs</span>(M))) / <span class="ty">float</span>(<span class="fn">Factorial</span>(L + <span class="fn">Abs</span>(M))))
);
<span class="kw">if</span> (M != <span class="num">0</span>)
    NormalizationConstants[BasisIndex] *= <span class="fn">Sqrt</span>(<span class="num">2.f</span>);   <span class="cm">// m≠0 밴드는 √2 배</span></div>

<p style="color:var(--text2);line-height:1.85;">
수식으로 쓰면 정규화 상수는 아래와 같다. <code>m≠0</code>일 때 붙는 <code>√2</code>는 복소 SH를 실수 SH로 바꾸며 sin/cos 쌍을 정규화하는 인자다.
</p>

<div class="formula">K_l^m = sqrt( (2l+1)/(4π) · (l-|m|)! / (l+|m|)! )   ,  (m≠0 이면 × √2)</div>

<p style="color:var(--text2);line-height:1.85;">
<code>l=0, m=0</code>을 넣어 보자. <code>K_0^0 = √(1/4π) = 1/(2√π) ≈ 0.282095</code>. 바로 그 DC 상수다. <code>l=1</code>이면 <code>√(3/4π) ≈ 0.488603</code>, <code>l=2</code>의 대각 항들은 <code>√(15/4π) ≈ 1.092548</code>. 여기에 방향 성분(르장드르 다항식과 <code>sin/cos(mφ)</code>)을 곱하면 기저함수가 완성된다. UE는 일반 차수에서는 <code>SHBasisFunction</code>이 <code>LegendrePolynomial()</code>과 <code>atan2</code> 기반 φ 항을 곱해 계산하지만, 2·3밴드는 <strong>삼각함수를 전개한 특수화 버전</strong>으로 대체해 비용을 없앤다. GPU에서는 아예 상수만 남는다.
</p>

<div class="code-block"><div class="code-lang">HLSL — SHCommon.ush (C++ SHBasisFunction을 전개한 것)</div><span class="ty">FThreeBandSHVector</span> <span class="fn">SHBasisFunction3</span>(<span class="ty">half3</span> V)
{
    <span class="ty">FThreeBandSHVector</span> R;
    <span class="cm">// l=0                         K_0^0</span>
    R.V0.x = <span class="num">0.282095f</span>;
    <span class="cm">// l=1   (y, z, x)             K_1 = 0.488603</span>
    R.V0.y = <span class="num">-0.488603f</span> * V.y;
    R.V0.z =  <span class="num">0.488603f</span> * V.z;
    R.V0.w = <span class="num">-0.488603f</span> * V.x;
    <span class="cm">// l=2                         K_2 = 1.092548, ...</span>
    R.V1.x =  <span class="num">1.092548f</span> * V.x*V.y;
    R.V1.y = <span class="num">-1.092548f</span> * V.y*V.z;
    R.V1.z =  <span class="num">0.315392f</span> * (<span class="num">3</span>*V.z*V.z - <span class="num">1</span>);   <span class="cm">// (3z²-1)</span>
    R.V1.w = <span class="num">-1.092548f</span> * V.x*V.z;
    R.V2   =  <span class="num">0.546274f</span> * (V.x*V.x - V.y*V.y); <span class="cm">// (x²-y²)</span>
    <span class="kw">return</span> R;
}</div>

<p style="color:var(--text2);line-height:1.85;">
정리하면 — <strong>기저값 = 정규화 상수 × (방향의 다항식)</strong>. 특정 방향 <code>ω</code>에서 이 9개 값을 평가한 것이 곧 그 방향의 SH "지문"이고, 어떤 임펄스 광원을 SH에 넣는다는 건 <code>SHBasisFunction3(방향) × 세기</code>를 계수 벡터에 더하는 일이다(<code>AddIncomingRadiance</code>).
</p>

<span class="section-eyebrow">04 — 압축이 성립하는 이유</span>
</div>

# 왜 9개로 "충분"한가: irradiance는 저주파다

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
2장은 "SH3이 9개"라는 <em>개수</em>를 유도했다. 하지만 진짜 질문은 <strong>"왜 9개에서 잘라도 되는가"</strong>다. 임의의 라이팅을 9계수로 자르면 당연히 정보가 손실된다. 뾰족한 하이라이트, 선명한 그림자 경계는 고주파라서 9계수로는 못 담는다. 그런데도 SH가 <strong>디퓨즈 조명</strong>에서 성립하는 이유는, 우리가 저장하려는 게 조명 자체(radiance)가 아니라 <strong>irradiance</strong> — 조명을 램버시안 코사인 커널로 흐린 결과 — 이기 때문이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이걸 정면으로 증명한 게 <strong>Ramamoorthi & Hanrahan의 2001년 논문 "An Efficient Representation for Irradiance Environment Maps"</strong>다. 논문의 핵심은 이렇다: 표면이 받는 irradiance <code>E(n)</code>은 입사 radiance <code>L</code>을 클램프 코사인 커널 <code>max(cos θ, 0)</code>과 <strong>구면 컨볼루션</strong>한 것이고, 이 커널은 주파수 영역에서 극도로 빠르게 감쇠한다. 컨볼루션 정리에 의해, 커널이 고주파를 죽이면 결과도 고주파가 죽는다. 그래서 <strong>입사광이 아무리 뾰족해도 irradiance는 밴드 2 이하의 저주파만 남는다.</strong>
</p>

<div class="callout callout-purple">
<div class="callout-title">Ramamoorthi & Hanrahan 2001 — 논문이 말한 숫자</div>
<p>논문 초록 그대로: <em>"one needs to compute and use only 9 coefficients, corresponding to the lowest-frequency modes of the illumination, in order to achieve average errors of only 1%."</em> — 조명의 최저주파 모드에 해당하는 <strong>9계수</strong>만으로 <strong>평균 오차 1%</strong>.</p>
<p>정량적으로: 클램프 코사인 필터 에너지의 <strong>99.2%가 밴드 0·1·2에 집중</strong>되고, 밴드가 홀수(<code>l&gt;1</code>)면 계수 <code>Â_l</code>이 <strong>정확히 0</strong>, 짝수는 <code>l^(-5/2)</code>로 급감한다. 최악의 픽셀 오차는 총광량의 9%, 임의의 물리적 조명에서 평균 오차는 3% 미만, 자연광 예시에서는 <strong>평균 1% 미만·최대 픽셀 5% 미만</strong>이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
숫자의 무게를 큐브맵과 비교하면 실감난다. 방향별 radiance를 담는 디퓨즈 조명용 큐브맵이 6×16×16×3 ≈ <strong>4,600 float</strong>이라면, 같은 irradiance를 SH3으로는 <strong>27 float</strong>에 담는다. 100배 이상 압축이면서, 디퓨즈 결과의 평균 오차는 1% 수준. 게다가 SH는 방향으로 미분 가능한 매끈한 함수라 큐브맵의 seam이나 필터링 아티팩트도 없다. "라이팅 압축값으로 SH를 쓰는" 이유가 여기 다 있다 — <strong>담아야 할 신호 자체가 저주파라서, 저주파 기저 몇 개가 정보의 거의 전부를 담는다.</strong>
</p>

<div class="callout callout-warn">
<div class="callout-title">한계도 여기서 나온다</div>
<p>이 논리는 <strong>디퓨즈에 한정</strong>된다. 코사인 커널이 저주파라서 성립하는 것이므로, 커널이 뾰족한 <strong>글로시/스페큘러 반사</strong>에는 그대로 적용되지 않는다. 광택 반사는 여전히 고주파라 SH3으로는 뭉개진다. SH가 프로브·스카이라이트의 <strong>디퓨즈</strong> 성분에만 쓰이고 반사는 별도 기법(리플렉션 캡처, SSR, RT reflection)이 담당하는 건 이 때문이다.</p>
</div>

<span class="section-eyebrow">05 — 디퓨즈 셰이딩 = 내적</span>
</div>

# π, 2π/3, π/4: 컨볼루션 계수가 코드가 되다

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
그럼 실제로 irradiance를 어떻게 뽑아 쓰는가. 저장된 것은 입사광의 SH 계수 <code>L_lm</code>이다. 여기에 클램프 코사인 커널의 <strong>밴드별 컨볼루션 계수 <code>Â_l</code></strong>을 곱하면 irradiance의 SH 계수 <code>E_lm</code>이 된다. Ramamoorthi가 유도한 이 계수는 밴드 0·1·2에서 다음과 같다.
</p>

<div class="formula">E_lm = Â_l · L_lm       (구면 컨볼루션: 밴드별 스칼라 곱)

  Â_0 = π       ≈ 3.141593     (밴드 0)
  Â_1 = 2π/3    ≈ 2.094395     (밴드 1)
  Â_2 = π/4     ≈ 0.785398     (밴드 2)
  Â_3 = 0 ,  Â_4 = −π/24 ,  Â_5 = 0 , ...   (홀수 l>1 은 0)</div>

<p style="color:var(--text2);line-height:1.85;">
이 <code>π, 2π/3, π/4</code>가 UE 코드에 <strong>글자 그대로</strong> 박혀 있다. <code>SHMath.h</code>의 <code>CalcDiffuseTransfer</code>는 방향의 기저값에 밴드별로 이 스케일을 곱해, "이 법선을 향한 디퓨즈 전달(transfer) 벡터"를 만든다.
</p>

<div class="code-block"><div class="code-lang">C++ — SHMath.h (CalcDiffuseTransfer)</div><span class="ty">TSHVector</span> <span class="fn">CalcDiffuseTransfer</span>(<span class="kw">const</span> <span class="ty">FVector</span>& Normal)
{
    <span class="ty">TSHVector</span> Result = <span class="fn">SHBasisFunction</span>(Normal);

    <span class="cm">// max(0, cos θ) 커널과의 컨볼루션 밴드 스케일</span>
    <span class="ty">float</span> L0 = PI;            <span class="cm">// Â_0</span>
    <span class="ty">float</span> L1 = <span class="num">2</span> * PI / <span class="num">3</span>;    <span class="cm">// Â_1</span>
    <span class="ty">float</span> L2 = PI / <span class="num">4</span>;        <span class="cm">// Â_2</span>

    <span class="kw">for</span> (<span class="ty">int32</span> i = <span class="num">0</span>; i &lt; MaxSHBasis; i++)
    {
        <span class="ty">float</span> Scale = (i &lt; <span class="num">1</span>) ? L0 : (i &lt; <span class="num">4</span>) ? L1 : L2;  <span class="cm">// 밴드별</span>
        Result.V[i] *= Scale;
    }
    <span class="kw">return</span> Result;
}</div>

<p style="color:var(--text2);line-height:1.85;">
GPU 쪽 <code>CalcDiffuseTransferSH3</code>는 한 발 더 나아가 코사인을 <code>max(0,cosθ)^Exponent</code>로 일반화한 파라메트릭 형태다. 그런데 <strong>Exponent=1을 넣으면 정확히 <code>π, 2π/3, π/4</code>로 환원</strong>된다 — 이론과 코드가 같은 값임을 스스로 증명한다.
</p>

<div class="code-block"><div class="code-lang">HLSL — SHCommon.ush</div><span class="ty">FThreeBandSHVector</span> <span class="fn">CalcDiffuseTransferSH3</span>(<span class="ty">half3</span> Normal, <span class="ty">half</span> Exponent)
{
    <span class="ty">FThreeBandSHVector</span> R = <span class="fn">SHBasisFunction3</span>(Normal);
    <span class="ty">half</span> L0 = <span class="num">2</span>*PI / (<span class="num">1</span> + Exponent);           <span class="cm">// E=1 → 2π/2 = π</span>
    <span class="ty">half</span> L1 = <span class="num">2</span>*PI / (<span class="num">2</span> + Exponent);           <span class="cm">// E=1 → 2π/3</span>
    <span class="ty">half</span> L2 = Exponent*<span class="num">2</span>*PI / (<span class="num">3</span>+<span class="num">4</span>*Exponent+Exponent*Exponent); <span class="cm">// E=1 → 2π/8 = π/4</span>
    R.V0.x *= L0;  R.V0.yzw *= L1;  R.V1 *= L2;  R.V2 *= L2;
    <span class="kw">return</span> R;
}

<span class="cm">// 최종 디퓨즈 조명: irradiance SH 와 transfer SH 의 내적 (밴드별 dot 합)</span>
<span class="ty">half</span> <span class="fn">DotSH3</span>(<span class="ty">FThreeBandSHVector</span> A, <span class="ty">FThreeBandSHVector</span> B)
{
    <span class="ty">half</span> r = <span class="fn">dot</span>(A.V0, B.V0);  r += <span class="fn">dot</span>(A.V1, B.V1);  r += A.V2 * B.V2;
    <span class="kw">return</span> r;
}</div>

<p style="color:var(--text2);line-height:1.85;">
이렇게 디퓨즈 셰이딩은 <code>DotSH3(IrradianceSH, CalcDiffuseTransferSH3(Normal, 1))</code> — <strong>내적 한 번</strong>으로 끝난다. 이것이 바로 <strong>Sloan-Kautz-Snyder의 Precomputed Radiance Transfer(PRT, 2002)</strong>가 정립한 관점이다: 저주파 조명 아래 디퓨즈 리시버의 셰이딩 적분은 <strong>조명 SH 벡터와 전달(transfer) SH 벡터의 내적</strong>으로 환원된다. 1장에서 본 "곱적분 = 내적" 성질(정규직교성)의 직접적 응용이다. 반구 적분이 9(또는 12) 곱셈-누산으로 바뀌는 이 지점이, SH가 실시간 GI의 밑바닥 저장 포맷으로 자리 잡은 결정적 이유다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">저장</div><div class="step-name">Irradiance SH</div><div class="step-desc">프로브/스카이라이트가 구운 9계수(RGB 27)</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">런타임</div><div class="step-name">Transfer SH</div><div class="step-desc">법선으로 CalcDiffuseTransferSH3 평가</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">셰이딩</div><div class="step-name">DotSH3</div><div class="step-desc">내적 한 번 = 디퓨즈 irradiance</div></div>
</div>

<span class="section-eyebrow">06 — SH directionality</span>
</div>

# SH directionality: l=1 밴드에서 방향을 되찾다

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
"SH directionality"는 <strong>SH로 표현된 라이팅에서 지배적인 광원 방향(dominant direction)을 뽑아내는 것</strong>을 말한다. 직관은 이렇다 — <code>l=0</code>(DC) 항은 방향이 없는 평균 밝기(ambient)다. 방향 정보는 <strong><code>l=1</code> 밴드의 세 계수</strong>에 들어 있다. 이 세 계수는 각각 x·y·z축 방향으로 완만하게 기우는 성분이라, <strong>세 값을 벡터로 묶으면 "빛이 대체로 어느 쪽에서 오는지"를 가리키는 화살표</strong>가 된다. 수학적으로 이는 구면 함수의 1차 모멘트(무게중심 방향)에 해당한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
UE는 이 아이디어를 <code>GetMaximumDirection</code>으로 구현한다. RGB SH를 휘도(luminance)로 접은 뒤, <code>l=1</code> 계수 세 개를 부호·축을 맞춰 벡터로 만들고 정규화한다. 주석이 밝히듯 이것은 <strong>1·2차 항만 쓰는 근사</strong>이지, SH를 최대화하는 방향의 정확해는 아니다.
</p>

<div class="code-block"><div class="code-lang">C++ / HLSL — SHMath.h:304, SHCommon.ush:204</div><span class="cm">// SH 함수가 가장 큰 방향의 근사 (1·2차 항만 사용)</span>
<span class="ty">FVector</span> <span class="fn">GetMaximumDirection</span>() <span class="kw">const</span>
{
    <span class="cm">// V[1],V[2],V[3] = l=1 밴드 (y, z, x). 축·부호를 월드로 정렬</span>
    <span class="kw">return</span> <span class="ty">FVector</span>(-V[<span class="num">3</span>], -V[<span class="num">1</span>], V[<span class="num">2</span>]).<span class="fn">GetSafeNormal</span>();
}

<span class="cm">// GPU: RGB SH를 휘도로 접은 뒤 지배 방향 추출</span>
<span class="ty">float3</span> <span class="fn">GetMaximumDirection</span>(<span class="ty">FTwoBandSHVector</span> SH)
{
    <span class="ty">float3</span> Dir = <span class="ty">float3</span>(-SH.V.w, -SH.V.y, SH.V.z);   <span class="cm">// (-L1x,-L1y,+L1z)</span>
    <span class="kw">return</span> Dir / <span class="fn">max</span>(<span class="fn">length</span>(Dir), <span class="num">.0001f</span>);
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 방향값을 어디에 쓰는가. UE 5.8에서 뚜렷한 소비자는 <strong>capsule shadow</strong>다. 스카이라이트나 볼류메트릭 라이트맵의 SH를 <code>GetLuminance</code>로 접고 <code>GetMaximumDirection</code>으로 지배 방향을 얻어, 그 방향을 향한 <strong>원뿔형 소프트 섀도우</strong>를 캐릭터·오브젝트에 드리운다. "방향 없는 SH ambient"에서 "그림자를 드리울 하나의 대표 방향"을 복원하는 것이다.
</p>

<div class="code-block"><div class="code-lang">HLSL — CapsuleShadowShaders.usf</div><span class="cm">// 볼류메트릭 라이트맵 SH → 휘도 → 지배 방향 → 캡슐 그림자 원뿔 방향</span>
<span class="ty">FTwoBandSHVectorRGB</span> IrradianceSH = <span class="fn">GetVolumetricLightmapSH2</span>(BrickUVs);
<span class="ty">float3</span> LightDirection = <span class="fn">GetMaximumDirection</span>(<span class="fn">GetLuminance</span>(IrradianceSH));</div>

<div class="callout callout-info">
<div class="callout-title">ambient vs directional 분리, 그리고 스페큘러 근사</div>
<p>더 일반적으로, SH 프로브는 흔히 <strong>"방향 없는 ambient(주로 DC 항) + 하나의 지배 방향광"</strong>으로 분해된다. 지배 방향이 있으면, SH가 원래 못 담는 <strong>스페큘러</strong>를 "그 방향에 놓인 가상의 방향광"으로 근사할 수 있다 — 프로브만으로 대략적인 하이라이트를 얻는 흔한 트릭이다.</p>
<p><em>정확도 주의:</em> 이 분해의 <strong>구체적 수치 레시피</strong>(에너지를 ambient와 방향광에 정확히 몇 대 몇으로 나누는가)는 엔진·구현마다 다르고 표준화된 공식이 있는 게 아니다. 이 글에서 코드로 확인 가능한 것은 UE의 <code>l=1</code> 기반 <code>GetMaximumDirection</code> 근사와 그 capsule-shadow 소비 경로까지다. 그 이상(특정 상용 엔진의 정확한 스페큘러 분해 상수)은 검증된 1차 출처로 확정하지 못했으므로 개념 수준으로만 소개한다.</p>
</div>

<span class="section-eyebrow">07 — UE의 실제 저장</span>
</div>

# 엔진 곳곳의 SH: 프로브·스카이·ILC·Lumen

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
이론이 코드가 되면 저장 포맷이 된다. UE 5.8에서 SH가 라이팅 압축값으로 쓰이는 대표 지점 네 곳을 훑는다. 공통 패턴은 <strong>DC(ambient) 항을 따로, 나머지 방향 계수를 정규화해서</strong> 담는 것이다 — DC가 밝기의 대부분을 쥐고 있어 정밀도를 몰아주기 때문이다.
</p>

<div class="data-table">
<table>
<tr><th>기능</th><th>SH 밴드</th><th>저장 방식</th><th>파일</th></tr>
<tr><td><strong>Volumetric Lightmap</strong></td><td>3밴드(9)</td><td>DC "AmbientVector" 3D 텍스처 1장 + 계수 6장(정규화·상대 저장)</td><td><code>VolumetricLightmapShared.ush</code></td></tr>
<tr><td><strong>Skylight</strong></td><td>3밴드 RGB(27)</td><td>7×<code>float4</code> 버퍼에 디퓨즈 컨볼루션·정규화까지 미리 구워 넣음 → 셰이더는 dot 7번</td><td><code>ReflectionEnvironmentShared.ush</code></td></tr>
<tr><td><strong>Indirect Lighting Cache</strong></td><td>2밴드 또는 3밴드</td><td>볼륨 텍스처(2밴드) 또는 uniform 배열(3밴드) 보간 샘플</td><td><code>BasePassPixelShader.usf</code></td></tr>
<tr><td><strong>Lumen</strong></td><td>2밴드·3밴드</td><td>radiance/irradiance를 SH로 인코딩, 스크린 프로브·라디언스 캐시</td><td><code>Lumen/*.usf</code></td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>볼류메트릭 라이트맵</strong>은 셀마다 3밴드 SH를 저장하되, DC RGB를 별도 <code>AmbientVector</code> 텍스처에 두고 나머지 6개 계수 텍스처는 <strong>[0,1]로 정규화해 ambient에 상대적으로</strong> 담는다. 샘플 시 <code>*2-1</code>로 복호화하고 미리 나눠 둔 정규화 스케일과 ambient를 곱해 원 계수를 복원한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>스카이라이트</strong>가 가장 영리하다. 3밴드 RGB(27) SH에 <strong>디퓨즈 컨볼루션(π, 2π/3, π/4)과 기저 정규화 상수를 CPU에서 미리 곱해</strong> 7개의 <code>float4</code>로 압축한다. 그래서 런타임 <code>GetSkySHDiffuse(Normal)</code>은 기저 평가도 컨볼루션도 없이 <strong>내적 7번 + max(0,·)</strong>만으로 법선 방향 디퓨즈 irradiance를 뱉는다 — 5장의 파이프라인 전체를 한 함수로 접어 넣은 셈이다.
</p>

<div class="code-block"><div class="code-lang">HLSL — ReflectionEnvironmentShared.ush (GetSkySHDiffuse 요지)</div><span class="cm">// 사전에 컨볼루션·정규화가 구워진 7×float4 버퍼에 법선을 내적</span>
<span class="ty">float4</span> N = <span class="ty">float4</span>(Normal, <span class="num">1</span>);
I0.x = <span class="fn">dot</span>(SkyIrradianceEnvironmentMap[<span class="num">0</span>], N);  <span class="cm">// R, l=0·1</span>
<span class="cm">// ... [1],[2] = G,B / [3..5] = l=2 / [6] = (x²-y²) 항 ...</span>
<span class="kw">return</span> <span class="fn">max</span>(<span class="num">0</span>, I0 + I1 + I2);   <span class="cm">// 방향별 디퓨즈 irradiance</span></div>

<p style="color:var(--text2);line-height:1.85;">
<strong>Lumen</strong>도 SH를 곳곳에서 쓴다. 스크린 프로브는 방향별 radiance를 <code>MulSH3(SHBasisFunction3(dir), Radiance)</code>로 3밴드 SH에 누적한 뒤, <code>4π · DotSH3(RadianceSH, CalcDiffuseTransferSH3(N,1))</code>로 irradiance를 뽑는다. 라디언스 캐시는 3밴드 SH를 BRDF 중요도 샘플링의 PDF로까지 활용한다. 즉 SH는 "구운 정적 라이팅"만이 아니라 <strong>실시간 GI 파이프라인의 중간 표현</strong>으로도 살아 있다.
</p>

<span class="section-eyebrow">08 — 링잉과 windowing</span>
</div>

# Gibbs 링잉과 de-ringing

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
저주파에서 자르는 대가가 하나 있다 — <strong>Gibbs 현상(ringing)</strong>. 밝은 점광원처럼 고주파 신호를 저차 SH로 근사하면, 잘린 급수가 진동하며 <strong>원래 없던 음수(어두운 링)</strong>를 만든다. 셰이딩에서 이는 검은 얼룩이나 과장된 명암으로 나타난다. Peter-Pike Sloan의 <strong>"Stupid Spherical Harmonics (SH) Tricks" (GDC 2008)</strong>는 이 문제와 대응책을 정리한 사실상의 표준 참고서다.
</p>

<p style="color:var(--text2);line-height:1.85;">
해법은 <strong>windowing(de-ringing)</strong> — 높은 밴드의 계수를 부드럽게 눌러(감쇠) 진동을 죽인다. UE는 논문의 방식을 그대로 구현한다. <code>ApplyWindowing</code>은 밴드 <code>l</code>의 계수에 <code>1/(1 + λ·l²(l+1)²)</code>를 곱한다. <code>λ</code>가 클수록 고주파가 세게 눌린다. <code>FindWindowingLambda</code>는 목표 라플라시안(진동 에너지)에 맞춰 뉴턴법으로 <code>λ</code>를 자동으로 푼다 — 논문 부록 A7 그대로다.
</p>

<div class="code-block"><div class="code-lang">C++ — SHMath.h (ApplyWindowing)</div><span class="cm">// "Stupid Spherical Harmonics (SH) Tricks" — weighted squared Laplacian 최소화</span>
<span class="kw">void</span> <span class="fn">ApplyWindowing</span>(<span class="ty">float</span> Lambda)
{
    <span class="kw">for</span> (<span class="ty">int32</span> l = <span class="num">0</span>; l &lt; MaxSHOrder; l++)
    {
        <span class="cm">// 밴드가 높을수록(l 큼) 강하게 감쇠</span>
        <span class="kw">const</span> <span class="ty">float</span> BandScale = <span class="num">1.0f</span> / (<span class="num">1.0f</span> + Lambda * <span class="ty">float</span>(l*l * (l+<span class="num">1</span>)*(l+<span class="num">1</span>)));
        <span class="kw">for</span> (<span class="ty">int32</span> m = -l; m &lt;= l; m++)
            V[<span class="fn">SHGetBasisIndex</span>(l, m)] *= BandScale;
    }
}</div>

<p style="color:var(--text2);line-height:1.85;">
같은 파일의 <code>Normalize</code>(적분이 1이 되도록 스케일), <code>CalcIntegral</code>(<code>= V[0] · 2√π</code>, DC 항만으로 구면 적분값), <code>AmbientFunction</code>(<code>V[0] = 1/(2√π)</code>로 균일광 표현) 같은 유틸도 모두 1~3장에서 유도한 상수의 응용이다. 특히 <code>CalcIntegral</code>이 <strong>DC 계수 하나</strong>로 구면 전체 적분을 주는 건, <code>l&gt;0</code> 기저의 구면 적분이 0(정규직교성)이기 때문이다.
</p>

<span class="section-eyebrow">정리</span>
</div>

# 정리

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
SH를 한 문장으로 압축하면 — <strong>«구면 위의 저주파 라이팅 함수를, 밴드마다 <code>2l+1</code>개인 정규직교 기저로 사영해 <code>(N+1)²</code>개의 계수로 담고, 셰이딩은 조명 SH와 코사인-컨볼루션 전달 SH의 내적 한 번으로 푸는» 라이팅 압축·적분 도구</strong>다. SH3에서 계수가 9개(RGB 27개)인 것은 <code>1+3+5</code>라는 산수의 결과이고, 그 9개로 "충분"한 것은 디퓨즈 irradiance가 클램프 코사인 커널로 흐려진 <strong>저주파 신호</strong>라는 Ramamoorthi-Hanrahan의 증명 덕분이다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">(N+1)²</div>
<div class="card-title">개수의 유도</div>
<div class="card-desc">밴드 l마다 기저 2l+1개, 합이 완전제곱수. SH3 = 1+3+5 = 9. UE <code>MaxSHBasis = Order²</code>, 인덱스 <code>l(l+1)+m</code>.</div>
</div>
<div class="card purple">
<div class="card-label">1% 오차</div>
<div class="card-title">압축의 근거</div>
<div class="card-desc">irradiance는 저주파 → 필터 에너지 99.2%가 밴드 0~2. 9계수로 평균 오차 1%. 큐브맵 대비 100배 압축.</div>
</div>
<div class="card teal">
<div class="card-label">π · 2π/3 · π/4</div>
<div class="card-title">셰이딩 = 내적</div>
<div class="card-desc">컨볼루션 밴드 계수가 <code>CalcDiffuseTransfer</code>의 L0/L1/L2로 그대로. 디퓨즈 = <code>DotSH3</code> 한 번(PRT).</div>
</div>
<div class="card gold">
<div class="card-label">l=1 밴드</div>
<div class="card-title">directionality</div>
<div class="card-desc">선형 계수 3개로 지배 방향 복원(<code>GetMaximumDirection</code>). capsule shadow가 원뿔 방향으로 소비. ambient/방향 분리로 스페큘러 근사.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
숫자로 다시 새기면 — 밴드당 계수 <code>2l+1</code>, SH3 = 9(SIMD 정렬 12 float), RGB = 27, DC 기저 <code>1/(2√π) ≈ 0.282095</code>, <code>l=1</code> 기저 <code>√(3/4π) ≈ 0.488603</code>, 컨볼루션 계수 <code>π · 2π/3 · π/4</code>, 구면 적분 상수 <code>2√π</code>. 이 값들은 대부분 Ramamoorthi-Hanrahan(2001)·Sloan(2002/2008)의 결과가 UE 코드에 상수로 굳은 것이다. 라이팅 파이프라인의 계보에서 SH는 <strong>큐브맵의 무거운 방향별 저장과, 순수 실시간 광선 추적 사이에 놓인 "저주파 라이팅의 표준 압축 포맷"</strong>이다. <a href="/ddgi">DDGI</a>가 octahedral 텍스처로 조도장을 담고, Lumen이 스크린 프로브를 굴리는 그 밑바닥에서도, 방향별 조명을 소수의 실수로 접는 이 도구가 여전히 돌아가고 있다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card purple">
<div class="card-label">원 논문 (2001)</div>
<div class="card-title">An Efficient Representation for Irradiance Environment Maps</div>
<div class="card-desc"><a href="https://cseweb.ucsd.edu/~ravir/papers/envmap/envmap.pdf">cseweb.ucsd.edu/~ravir/papers/envmap</a> — Ramamoorthi & Hanrahan, SIGGRAPH 2001. "9계수·평균 오차 1%"의 출처. 클램프 코사인 커널의 밴드 계수와 저주파성 증명.</div>
</div>
<div class="card blue">
<div class="card-label">PRT (2002)</div>
<div class="card-title">Precomputed Radiance Transfer</div>
<div class="card-desc">Sloan, Kautz & Snyder, SIGGRAPH 2002. 디퓨즈 셰이딩을 조명 SH와 전달 SH의 내적으로 환원한 관점.</div>
</div>
<div class="card teal">
<div class="card-label">실전 트릭 (2008)</div>
<div class="card-title">Stupid Spherical Harmonics (SH) Tricks</div>
<div class="card-desc"><a href="https://www.ppsloan.org/publications/StupidSH36.pdf">ppsloan.org/publications/StupidSH36.pdf</a> — Peter-Pike Sloan, GDC 2008. windowing/de-ringing, Gibbs 링잉 대응. UE <code>ApplyWindowing</code>의 출처.</div>
</div>
<div class="card gold">
<div class="card-label">엔진 소스</div>
<div class="card-title">Unreal Engine 5.8</div>
<div class="card-desc"><code>Math/SHMath.h·.cpp</code>, <code>SHCommon.ush</code>, <code>VolumetricLightmapShared.ush</code>, <code>ReflectionEnvironmentShared.ush</code>, <code>BasePassPixelShader.usf</code>, <code>Lumen/*</code>, <code>CapsuleShadowShaders.usf</code>. 이 글 모든 상수·함수의 1차 출처.</div>
</div>
</div>
</div>
