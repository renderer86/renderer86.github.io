---

layout: post
title: "Spherical Harmonics: 방향의 함수를 숫자 9개로 접는 법 — 왜 하필 9개인지, 언리얼엔진은 어디에 쓰는지"
icon: paper
permalink: spherical-harmonics
categories: Rendering
tags: [ComputerGraphics, Rendering, SphericalHarmonics, GlobalIllumination, LightProbe, IrradianceMap, UnrealEngine, Lumen]
excerpt: "라이트 프로브 하나가 저장해야 하는 것은 '모든 방향에서 오는 빛'이라는 구면 위의 함수다. 게임 업계는 이 함수를 20년 넘게 숫자 9개(RGB면 27개)로 압축해왔다. 이 글은 spherical harmonics가 무엇인지에서 출발해, Ramamoorthi & Hanrahan 2001이 증명한 '9계수면 램버시안 irradiance의 99%'라는 수치의 출처와, order를 3·4로 올렸을 때 실제로 얻는 것과 잃는 것(ringing, negative lobe, n² 비용)을 짚는다. 이어서 언리얼엔진 5.8 소스에서 SH가 흐르는 경로를 코드로 추적한다. SHMath.h의 π·2π/3·π/4 상수, Volumetric Lightmap의 텍스처 인코딩, 스카이라이트의 7×float4 패킹, Lumen 스크린 프로브, 그리고 품질 경로는 3밴드·성능 경로는 2밴드로 갈라 쓰는 엔진의 일관된 규칙까지 다룬다."
back_color: "#ffffff"
img_name: "spherical-harmonics-core-sketch.png"
toc: false
show: true
new: true
series: -1
index: 25
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 라이트 프로브가 저장한다는 "SH 계수 9개(RGB면 27개)"가 정확히 무슨 숫자인지 궁금한 분
> - spherical harmonics를 수식 유도 없이, 그러나 얼버무리지 않고 이해하고 싶은 분
> - 왜 다들 L2(9계수)를 쓰는지, 감이 아니라 논문의 수치로 확인하고 싶은 분
> - "SH order를 높이면 더 좋아지지 않나?"라는 질문에 ringing·negative lobe·비용까지 포함한 답을 원하는 분
> - 언리얼엔진이 SH를 어느 파일 어느 함수에서 쓰는지, Volumetric Lightmap·스카이라이트·Lumen의 실제 인코딩을 코드로 보고 싶은 분
> - Unity·Halo 3·Far Cry 3·Frostbite가 각자 몇 계수를 골랐고 왜 갈렸는지 비교하고 싶은 분
>
> **이 글로 알 수 있는 내용**
>
> - SH가 "구면 위의 푸리에 급수"라는 것. 밴드 구조, order n에 계수 n²개, 프로젝션과 재구성이 각각 적분과 합이라는 것
> - 셰이더에 박히는 `0.282095`, `0.488603`, `1.092548` 같은 상수의 정체 (법선 x,y,z의 0·1·2차 다항식)
> - 게임에서 SH가 살아남은 세 가지 성질인 정규직교·회전 불변·zonal harmonics
> - "9개면 충분"의 수학적 근거인 clamped cosine의 SH 계수 **π, 2π/3, π/4, 0**. 홀수 밴드는 사라지고 짝수 밴드는 l<sup>−5/2</sup>로 감쇠한다
> - Basri & Jacobs의 에너지 수치: L1 = 87.5%, **L2 = 99.22%**, L4 = 99.81%. L2에서 L4로 가도 +0.6%p
> - 고차 SH의 함정: Gibbs ringing, HDR 광원의 negative lobe, 계수 n² 증가, 그리고 완화책 windowing
> - UE 5.8 `SHMath.h`의 `TSHVector`가 SH 상한을 3밴드로 못 박아 둔 구조, 그리고 `CalcDiffuseTransfer`의 밴드 상수
> - Volumetric Lightmap이 9계수를 "AmbientVector + RGBA8 텍스처 6장"에 접는 인코딩과 3단계 품질 경로(SH1/SH2/SH3)
> - 스카이라이트 큐브맵 → 9계수 프로젝션 → 7×float4 패킹 → `GetSkySHDiffuse`의 dot 3번 평가
> - Lumen 스크린 프로브가 매 프레임 실시간으로 3밴드 SH를 굽는 경로, ILC·Lightmass·반투명 볼륨·Volumetric Fog의 밴드 선택 규칙
> - Unity(L2·27 float) · Halo 3(SH 라이트맵) · Far Cry 3(L1) · Frostbite(L1·12계수) · ZH3(15계수, 2024)의 계보

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

<style>
.sh-post {
  --bg2: #f3f3fb;
  --surface: #f7f8fc;
  --surface2: #edeff8;
  --border: rgba(67,56,202,0.12);
  --border2: rgba(67,56,202,0.26);
  --text: #171a26;
  --text2: #414455;
  --text3: #7e8295;
  --accent: #4338ca;
  --accent2: #b45309;
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
  border-radius: 6px;
  padding: 18px;
}
.sh-post .card.blue   { border-color: rgba(67,56,202,0.20); }
.sh-post .card.purple { border-color: rgba(180,83,9,0.22); }
.sh-post .card.gold   { border-color: rgba(176,125,0,0.24); }
.sh-post .card.teal   { border-color: rgba(10,143,114,0.24); }
.sh-post .card.coral  { border-color: rgba(214,48,74,0.22); }
.sh-post .card-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.sh-post .card-label::before { content: '// '; color: var(--text3); font-weight: 400; }
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
  position: relative;
  background: var(--surface);
  border: 1px solid;
  border-radius: 6px;
  padding: 16px 20px;
  margin: 20px 0;
}
.sh-post .callout::after {
  position: absolute;
  top: 12px;
  right: 14px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
}
.sh-post .callout-info { border-color: rgba(67,56,202,0.20); }
.sh-post .callout-info::after { content: 'NOTE'; color: var(--accent); }
.sh-post .callout-warn { border-color: rgba(176,125,0,0.24); }
.sh-post .callout-warn::after { content: 'WARN'; color: var(--gold); }
.sh-post .callout-purple { border-color: rgba(180,83,9,0.22); }
.sh-post .callout-purple::after { content: 'DEEP'; color: var(--accent2); }
.sh-post .callout-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 10px;
  padding-right: 56px;
}
.sh-post .callout-title::before { content: '/* '; color: var(--text3); font-weight: 400; }
.sh-post .callout-title::after { content: ' */'; color: var(--text3); font-weight: 400; }
.sh-post .callout-info .callout-title { color: var(--accent); }
.sh-post .callout-warn .callout-title { color: var(--gold); }
.sh-post .callout-purple .callout-title { color: var(--accent2); }
.sh-post .callout p { margin: 0 0 8px 0; font-size: 13px; color: var(--text2); line-height: 1.75; }
.sh-post .callout p:last-child { margin: 0; }
.sh-post .code-block {
  background: #191c2e;
  border: 1px solid rgba(145,155,225,0.15);
  border-radius: 12px;
  padding: 20px 22px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  line-height: 1.85;
  overflow-x: auto;
  margin: 18px 0;
  position: relative;
  white-space: pre;
  color: #ccd2e8;
}
.sh-post .code-block .kw  { color: #a5b4fc; }
.sh-post .code-block .fn  { color: #86efac; }
.sh-post .code-block .cm  { color: #5e6480; font-style: italic; }
.sh-post .code-block .num { color: #fb923c; }
.sh-post .code-block .str { color: #fbbf24; }
.sh-post .code-block .ty  { color: #7dd3fc; }
.sh-post .code-lang {
  position: absolute;
  top: 10px; right: 14px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #5e6480;
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
.sh-post .flag-coral  { background: rgba(214,48,74,0.12);  color: var(--coral); }
.sh-post .flag-blue   { background: rgba(67,56,202,0.12);  color: var(--accent); }
.sh-post .flag-teal   { background: rgba(10,143,114,0.12); color: var(--teal); }
.sh-post .flag-gold   { background: rgba(176,125,0,0.12);  color: var(--gold); }
.sh-post .flag-purple { background: rgba(180,83,9,0.12);   color: var(--accent2); }
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
.sh-post .scene-fig {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 22px 20px;
  margin: 26px 0;
}
.sh-post .scene-fig svg { width: 100%; height: auto; display: block; }
.sh-post .scene-fig img { width: 100%; height: auto; display: block; border-radius: 10px; }
.sh-post .scene-cap { font-size: 12px; color: var(--text3); text-align: center; margin-top: 14px; line-height: 1.65; }
.sh-post .fig-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.sh-post .fig-item img { width: 100%; height: auto; display: block; border-radius: 8px; border: 1px solid var(--border); }
.sh-post .fig-item-label { font-size: 11.5px; color: var(--text2); text-align: center; margin-top: 8px; line-height: 1.6; }
</style>

<div class="sh-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: "구면 위의 함수"를 저장하는 문제

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
간접광을 다루는 순간 반드시 만나는 저장 문제가 있다. 표면 한 점이 받는 빛은 방향마다 다르다. 하늘 쪽은 파랗고, 바닥 쪽은 바운스된 갈색이고, 창문 쪽만 밝다. 그러니 라이트 프로브 하나가 저장해야 하는 것은 값 하나가 아니라 <strong>"모든 방향 ω에 대한 빛", 즉 구면 위에 정의된 함수</strong>다. 스카이라이트도 마찬가지다. 하늘 큐브맵이 주는 diffuse 조명은 "법선이 <b>n</b>인 표면이 받는 빛"이라는, 역시 구면 위의 함수다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 함수를 그대로 저장하는 방법이 없는 건 아니다. 큐브맵이 바로 그 방식이다. 그런데 게임은 이런 프로브를 씬에 <strong>수천~수만 개</strong> 깐다. 언리얼의 Volumetric Lightmap은 브릭당 4³ = 64개 셀이고, Lumen은 화면에 프로브를 매 프레임 새로 만든다. 프로브 하나에 큐브맵 한 장씩 줄 수는 없다. 프로브당 예산은 <strong>수십 바이트</strong>이고, 읽기는 텍스처 페치 몇 번·ALU 몇 개 안에 끝나야 하고, 이웃 프로브와 <strong>선형 보간</strong>이 되어야 하고, 오브젝트가 돌면 조명도 <strong>회전</strong>할 수 있어야 한다.
</p>

<div class="scene-fig">
<div class="fig-grid3">
<div class="fig-item">
<svg viewBox="0 0 280 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="구 표면의 점들이 각자 주변을 캡처하는 그림. 위쪽 점은 하늘을, 오른쪽 점은 빨간 벽을, 아래 점은 바닥을 본다">
<defs>
<radialGradient id="sh1-sp" cx="0.38" cy="0.3" r="0.95"><stop offset="0" stop-color="#f4f7fb"/><stop offset="0.55" stop-color="#c3ccdb"/><stop offset="1" stop-color="#67707f"/></radialGradient>
<clipPath id="sh1-za"><circle cx="52" cy="50" r="30"/></clipPath>
<clipPath id="sh1-zb"><circle cx="230" cy="48" r="30"/></clipPath>
<clipPath id="sh1-zc"><circle cx="38" cy="150" r="28"/></clipPath>
</defs>
<ellipse cx="130" cy="30" rx="72" ry="12" fill="#a8cbf0" opacity="0.8"/>
<ellipse cx="180" cy="24" rx="42" ry="9" fill="#bcd8f5" opacity="0.75"/>
<rect x="8" y="210" width="264" height="9" rx="2" fill="#d9a441"/>
<rect x="228" y="96" width="26" height="114" rx="3" fill="#d6304a"/>
<circle cx="118" cy="158" r="52" fill="url(#sh1-sp)" stroke="#2b2f3d" stroke-width="2"/>
<line x1="118" y1="106" x2="63" y2="66" stroke="#414455" stroke-width="1"/>
<line x1="158" y1="125" x2="205" y2="62" stroke="#414455" stroke-width="1"/>
<line x1="75" y1="188" x2="56" y2="166" stroke="#414455" stroke-width="1"/>
<g clip-path="url(#sh1-za)">
<rect x="22" y="20" width="60" height="60" fill="#8fc1ee"/>
<ellipse cx="52" cy="44" rx="17" ry="6" fill="#d9ebfc"/>
</g>
<circle cx="52" cy="50" r="30" fill="none" stroke="#2b2f3d" stroke-width="2"/>
<g clip-path="url(#sh1-zb)">
<rect x="200" y="18" width="62" height="60" fill="#edf2f9"/>
<rect x="238" y="18" width="24" height="60" fill="#d6304a"/>
<rect x="200" y="70" width="62" height="8" fill="#d9a441" opacity="0.7"/>
</g>
<circle cx="230" cy="48" r="30" fill="none" stroke="#2b2f3d" stroke-width="2"/>
<g clip-path="url(#sh1-zc)">
<rect x="10" y="122" width="56" height="56" fill="#cfd8e6"/>
<path d="M 66 150 A 28 28 0 0 1 10 150 Z" fill="#d9a441"/>
<path d="M 38 122 A 28 28 0 0 1 66 150 L 38 150 Z" fill="#4b5563"/>
</g>
<circle cx="38" cy="150" r="28" fill="none" stroke="#2b2f3d" stroke-width="2"/>
<circle cx="118" cy="106" r="4" fill="#d6304a" stroke="#ffffff" stroke-width="1.2"/>
<circle cx="158" cy="125" r="4" fill="#d6304a" stroke="#ffffff" stroke-width="1.2"/>
<circle cx="75" cy="188" r="4" fill="#d6304a" stroke="#ffffff" stroke-width="1.2"/>
</svg>
<div class="fig-item-label">① 표면 위 한 점에서 <strong>모든 방향</strong>을 캡처한다. 점마다 보이는 세상이 다르다</div>
</div>
<div class="fig-item">
<svg viewBox="0 0 280 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="구 둘레의 점마다 캡처한 환경맵을 작은 구슬로 표현한 그림. 구슬마다 하늘·벽·바닥이 선명하게 비친다">
<defs>
<radialGradient id="sh2-sp" cx="0.38" cy="0.3" r="0.95"><stop offset="0" stop-color="#f4f7fb"/><stop offset="0.55" stop-color="#c3ccdb"/><stop offset="1" stop-color="#67707f"/></radialGradient>
</defs>
<ellipse cx="130" cy="30" rx="72" ry="12" fill="#a8cbf0" opacity="0.8"/>
<ellipse cx="180" cy="24" rx="42" ry="9" fill="#bcd8f5" opacity="0.75"/>
<rect x="8" y="210" width="264" height="9" rx="2" fill="#d9a441"/>
<rect x="228" y="96" width="26" height="114" rx="3" fill="#d6304a"/>
<circle cx="118" cy="158" r="52" fill="url(#sh2-sp)" stroke="#2b2f3d" stroke-width="2"/>
<g stroke="#2b2f3d" stroke-width="1.5">
<circle cx="118" cy="92" r="12" fill="#eef4fb"/>
<circle cx="157" cy="105" r="12" fill="#eef4fb"/>
<circle cx="181" cy="138" r="12" fill="#eef4fb"/>
<circle cx="181" cy="178" r="12" fill="#eef4fb"/>
<circle cx="157" cy="211" r="12" fill="#eef4fb"/>
<circle cx="118" cy="224" r="12" fill="#eef4fb"/>
<circle cx="79" cy="211" r="12" fill="#eef4fb"/>
<circle cx="55" cy="178" r="12" fill="#eef4fb"/>
<circle cx="55" cy="138" r="12" fill="#eef4fb"/>
<circle cx="79" cy="105" r="12" fill="#eef4fb"/>
</g>
<path d="M 106 92 A 12 12 0 0 1 130 92 Z" fill="#8fc1ee"/>
<path d="M 145 105 A 12 12 0 0 1 169 105 Z" fill="#8fc1ee"/>
<path d="M 67 105 A 12 12 0 0 1 91 105 Z" fill="#8fc1ee"/>
<path d="M 181 126 A 12 12 0 0 1 181 150 Z" fill="#d6304a" opacity="0.9"/>
<path d="M 181 166 A 12 12 0 0 1 181 190 Z" fill="#d6304a" opacity="0.9"/>
<path d="M 169 211 A 12 12 0 0 1 145 211 Z" fill="#d9a441"/>
<path d="M 130 224 A 12 12 0 0 1 106 224 Z" fill="#d9a441"/>
<rect x="110" y="228" width="16" height="3" fill="#454a57"/>
<path d="M 91 211 A 12 12 0 0 1 67 211 Z" fill="#d9a441"/>
<path d="M 55 190 A 12 12 0 0 1 55 166 Z" fill="#b9c2d4"/>
<path d="M 55 150 A 12 12 0 0 1 55 126 Z" fill="#b9c2d4"/>
<g fill="none" stroke="#2b2f3d" stroke-width="1.5">
<circle cx="118" cy="92" r="12"/>
<circle cx="157" cy="105" r="12"/>
<circle cx="181" cy="138" r="12"/>
<circle cx="181" cy="178" r="12"/>
<circle cx="157" cy="211" r="12"/>
<circle cx="118" cy="224" r="12"/>
<circle cx="79" cy="211" r="12"/>
<circle cx="55" cy="178" r="12"/>
<circle cx="55" cy="138" r="12"/>
<circle cx="79" cy="105" r="12"/>
</g>
</svg>
<div class="fig-item-label">② 캡처를 그대로 저장하면 구슬(프로브) 하나가 큐브맵 한 장이다</div>
</div>
<div class="fig-item">
<svg viewBox="0 0 280 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="같은 구슬들이 SH 근사로 디테일을 잃고 부드러운 밝기 그라데이션만 남은 그림">
<defs>
<radialGradient id="sh3-sp" cx="0.38" cy="0.3" r="0.95"><stop offset="0" stop-color="#f4f7fb"/><stop offset="0.55" stop-color="#c3ccdb"/><stop offset="1" stop-color="#67707f"/></radialGradient>
<radialGradient id="sh3-bs" cx="0.4" cy="0.35" r="0.9"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#9dbfe6"/></radialGradient>
<radialGradient id="sh3-br" cx="0.4" cy="0.35" r="0.9"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfa0aa"/></radialGradient>
<radialGradient id="sh3-bw" cx="0.4" cy="0.35" r="0.9"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d8bd85"/></radialGradient>
<radialGradient id="sh3-bn" cx="0.4" cy="0.35" r="0.9"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c3cde0"/></radialGradient>
</defs>
<ellipse cx="130" cy="30" rx="72" ry="12" fill="#a8cbf0" opacity="0.8"/>
<ellipse cx="180" cy="24" rx="42" ry="9" fill="#bcd8f5" opacity="0.75"/>
<rect x="8" y="210" width="264" height="9" rx="2" fill="#d9a441"/>
<rect x="228" y="96" width="26" height="114" rx="3" fill="#d6304a"/>
<circle cx="118" cy="158" r="52" fill="url(#sh3-sp)" stroke="#2b2f3d" stroke-width="2"/>
<g stroke="#2b2f3d" stroke-width="1.5">
<circle cx="118" cy="92" r="12" fill="url(#sh3-bs)"/>
<circle cx="157" cy="105" r="12" fill="url(#sh3-bs)"/>
<circle cx="79" cy="105" r="12" fill="url(#sh3-bs)"/>
<circle cx="181" cy="138" r="12" fill="url(#sh3-br)"/>
<circle cx="181" cy="178" r="12" fill="url(#sh3-br)"/>
<circle cx="157" cy="211" r="12" fill="url(#sh3-bw)"/>
<circle cx="118" cy="224" r="12" fill="url(#sh3-bw)"/>
<circle cx="79" cy="211" r="12" fill="url(#sh3-bw)"/>
<circle cx="55" cy="178" r="12" fill="url(#sh3-bn)"/>
<circle cx="55" cy="138" r="12" fill="url(#sh3-bn)"/>
</g>
</svg>
<div class="fig-item-label">③ 같은 구슬을 SH로 접으면 디테일은 사라지고 밝기 분포만 남는다</div>
</div>
</div>
<div class="scene-cap">한 점이 받는 빛을 사방으로 캡처한 것이 환경맵(큐브맵)이고(①), 이걸 점마다 두면 프로브가 된다(②). SH는 그 캡처에서 <strong>저주파 밝기 분포만</strong> 남기는 압축이다(③). 벽의 윤곽 같은 디테일은 사라지지만, diffuse 조명에는 이것으로 충분하다는 것이 03장의 주제다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 조건을 전부 만족하는 표준 답이 <strong>spherical harmonics(구면 조화 함수, 이하 SH)</strong>다. 그리고 서로 합의한 적도 없는 엔진들이 신기하게도 같은 선택에 도달해 있다. 바로 <strong>계수 9개</strong>(RGB면 27개), 이른바 L2 SH다. 언리얼의 볼류메트릭 라이트맵도, Unity의 라이트 프로브도, Halo 3의 라이트맵도 9개를 쓴다. 이 글은 그 9라는 숫자가 어디서 왔는지를 논문의 수치로 확인하고, order를 더 올리면 무엇을 얻고 잃는지 따진 다음, 언리얼엔진 5.8 소스에서 SH가 실제로 흐르는 경로를 코드로 추적한다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
<p>이 글의 엔진 분석은 <strong>언리얼엔진 5.8 소스</strong>를 직접 읽고 정리한 것이다. <code>Runtime/Core/Public/Math/SHMath.h</code>(SH 수학 코어), <code>Shaders/Private/SHCommon.ush</code>(셰이더 대응), <code>PrecomputedVolumetricLightmap.h/.cpp</code> · <code>VolumetricLightmapShared.ush</code>(볼류메트릭 라이트맵), <code>ReflectionEnvironment.cpp</code> · <code>ReflectionEnvironmentShared.ush</code>(스카이라이트), <code>LumenScreenProbeFiltering.usf</code>(Lumen), <code>IndirectLightingCache.cpp</code>, UnrealLightmass의 <code>ImportExport.h</code> · <code>SampleVolume.cpp</code> 등을 참고했다. 이론은 <strong>Ramamoorthi &amp; Hanrahan의 SIGGRAPH 2001 논문</strong>과 <strong>Peter-Pike Sloan의 "Stupid Spherical Harmonics (SH) Tricks"(GDC 2008)</strong>를 1차 출처로 삼았고, 인용한 수치는 원문에서 확인했다(→ 참고).</p>
</div>

<span class="section-eyebrow">01 — SH 기초</span>

</div>

# SH는 구면 위의 푸리에 급수다

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
1차원 주기 함수를 sin·cos의 합으로 분해하는 것이 푸리에 급수다. 낮은 주파수 항 몇 개만 남기면 함수의 "대체적인 모양"이 적은 숫자로 압축된다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 300" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace" role="img" aria-label="계단식 함수가 sin 성분 3개로 분해되고, 계수를 곱해 더하면 다시 복원되는 푸리에 급수 그림">
<defs>
<marker id="shfr-arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7e8295"/></marker>
</defs>

<!-- 왼쪽: 계단식 함수와 3항 근사 -->

<text x="180" y="26" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">계단식 함수의 3항 근사</text>
<line x1="40" y1="150" x2="320" y2="150" stroke="#4a4a5c" stroke-width="1.2"/>
<text x="33" y="154" fill="#7e8295" font-size="9" text-anchor="end">0</text>
<text x="326" y="154" fill="#7e8295" font-size="9" text-anchor="start">2π</text>
<path d="M 40 95 L 180 95 L 180 205 L 320 205" fill="none" stroke="#7e8295" stroke-width="1.6" stroke-dasharray="5 4"/>
<path d="M 40 150 L 48.75 111.7 L 57.5 88.7 L 66.25 85.5 L 75 93.9 L 83.75 101 L 92.5 99.6 L 101.25 92.9 L 110 89.3 L 118.75 92.9 L 127.5 99.6 L 136.25 101 L 145 93.9 L 153.75 85.5 L 162.5 88.7 L 171.25 111.7 L 180 150 L 188.75 188.3 L 197.5 211.3 L 206.25 214.5 L 215 206.1 L 223.75 199 L 232.5 200.4 L 241.25 207.1 L 250 210.7 L 258.75 207.1 L 267.5 200.4 L 276.25 199 L 285 206.1 L 293.75 214.5 L 302.5 211.3 L 311.25 188.3 L 320 150" fill="none" stroke="#4338ca" stroke-width="2.2"/>
<line x1="156" y1="84" x2="194" y2="79" stroke="#d6304a" stroke-width="0.9"/>
<text x="197" y="82" fill="#d6304a" font-size="9" text-anchor="start">과잉 진동(→ ringing)</text>
<line x1="40" y1="258" x2="68" y2="258" stroke="#7e8295" stroke-width="1.6" stroke-dasharray="5 4"/>
<text x="74" y="262" fill="#7e8295" font-size="9.5" text-anchor="start">원본 f(θ)</text>
<line x1="160" y1="258" x2="188" y2="258" stroke="#4338ca" stroke-width="2.2"/>
<text x="194" y="262" fill="#7e8295" font-size="9.5" text-anchor="start">저주파 3항 근사</text>

<!-- 가운데: 분해/복원 화살표 -->

<text x="392" y="100" fill="#7e8295" font-size="9" text-anchor="middle">분해(프로젝션)</text>
<text x="392" y="112" fill="#7e8295" font-size="9" text-anchor="middle">성분별 계수는 적분으로</text>
<line x1="337" y1="122" x2="448" y2="122" stroke="#7e8295" stroke-width="1.2" marker-end="url(#shfr-arr)"/>
<rect x="336" y="136" width="112" height="30" rx="6" fill="#edeff8" stroke="rgba(67,56,202,0.26)" stroke-width="1"/>
<text x="392" y="149" fill="#4338ca" font-size="9" font-weight="600" text-anchor="middle">[1.27, 0.42, 0.25]</text>
<text x="392" y="161" fill="#7e8295" font-size="8.5" text-anchor="middle">저장은 이 숫자 3개뿐</text>
<line x1="448" y1="180" x2="337" y2="180" stroke="#7e8295" stroke-width="1.2" marker-end="url(#shfr-arr)"/>
<text x="392" y="198" fill="#7e8295" font-size="9" text-anchor="middle">복원(재구성)</text>
<text x="392" y="210" fill="#7e8295" font-size="9" text-anchor="middle">계수 × 성분의 합</text>

<!-- 오른쪽: 주파수 성분 3개 -->

<text x="600" y="26" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">주파수 성분 3개 (계수 × sin파)</text>
<line x1="460" y1="70" x2="740" y2="70" stroke="#4a4a5c" stroke-width="1"/>
<path d="M 460 70 L 468.75 64.1 L 477.5 58.5 L 486.25 53.3 L 495 48.8 L 503.75 45.1 L 512.5 42.3 L 521.25 40.6 L 530 40 L 538.75 40.6 L 547.5 42.3 L 556.25 45.1 L 565 48.8 L 573.75 53.3 L 582.5 58.5 L 591.25 64.1 L 600 70 L 608.75 75.9 L 617.5 81.5 L 626.25 86.7 L 635 91.2 L 643.75 94.9 L 652.5 97.7 L 661.25 99.4 L 670 100 L 678.75 99.4 L 687.5 97.7 L 696.25 94.9 L 705 91.2 L 713.75 86.7 L 722.5 81.5 L 731.25 75.9 L 740 70" fill="none" stroke="#0a8f72" stroke-width="2"/>
<text x="462" y="97" fill="#0a8f72" font-size="9.5" text-anchor="start">계수 1.27 × sin θ</text>
<line x1="460" y1="150" x2="740" y2="150" stroke="#4a4a5c" stroke-width="1"/>
<path d="M 460 150 L 468.75 144.4 L 477.5 140.8 L 486.25 140.2 L 495 142.9 L 503.75 148.1 L 512.5 153.8 L 521.25 158.3 L 530 160 L 538.75 158.3 L 547.5 153.8 L 556.25 148.1 L 565 142.9 L 573.75 140.2 L 582.5 140.8 L 591.25 144.4 L 600 150 L 608.75 155.6 L 617.5 159.2 L 626.25 159.8 L 635 157.1 L 643.75 151.9 L 652.5 146.2 L 661.25 141.7 L 670 140 L 678.75 141.7 L 687.5 146.2 L 696.25 151.9 L 705 157.1 L 713.75 159.8 L 722.5 159.2 L 731.25 155.6 L 740 150" fill="none" stroke="#b07d00" stroke-width="2"/>
<text x="462" y="177" fill="#b07d00" font-size="9.5" text-anchor="start">계수 0.42 × sin 3θ</text>
<line x1="460" y1="230" x2="740" y2="230" stroke="#4a4a5c" stroke-width="1"/>
<path d="M 460 230 L 468.75 225 L 477.5 224.5 L 486.25 228.8 L 495 234.2 L 503.75 235.9 L 512.5 232.3 L 521.25 226.7 L 530 224 L 538.75 226.7 L 547.5 232.3 L 556.25 235.9 L 565 234.2 L 573.75 228.8 L 582.5 224.5 L 591.25 225 L 600 230 L 608.75 235 L 617.5 235.5 L 626.25 231.2 L 635 225.8 L 643.75 224.1 L 652.5 227.7 L 661.25 233.3 L 670 236 L 678.75 233.3 L 687.5 227.7 L 696.25 224.1 L 705 225.8 L 713.75 231.2 L 722.5 235.5 L 731.25 235 L 740 230" fill="none" stroke="#d6304a" stroke-width="2"/>
<text x="462" y="257" fill="#d6304a" font-size="9.5" text-anchor="start">계수 0.25 × sin 5θ</text>
</svg>

<div class="scene-cap">계단처럼 각진 함수(회색 점선)조차 부드러운 sin 성분들의 합으로 표현된다. 함수 전체를 저장하는 대신 <strong>성분별 계수 몇 개</strong>(여기서는 1.27, 0.42, 0.25)만 저장하면 되고, 계수 × 성분의 합으로 언제든 복원할 수 있다. 이 분해와 복원이 푸리에 급수다. 성분을 낮은 주파수 3개에서 자르면 큰 모양만 남는 저주파 근사(남색 실선)가 되고, 불연속 주변에는 과잉 진동이 남는다(→ 04장 ringing).</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>SH는 정확히 같은 일을 구면 위에서 한다.</strong> 위 그림의 sin·cos 자리에 <i>Y</i><sub>lm</sub>이라는 구면용 basis 함수가 들어간다고 보면 된다. 짚어 둘 점은 basis가 <strong>미리 약속해 둔 고정 함수 목록</strong>이라는 것이다. sin θ는 한 바퀴에 한 번, sin 3θ는 세 번, sin 5θ는 다섯 번 오르내리는 정해진 모양이고, 어떤 데이터를 만나도 이 모양들 자체는 변하지 않는다. 데이터마다 달라지는 것은 각 모양에 곱하는 계수뿐이다. 그리고 이 목록은 천천히 변하는 모양(sin θ)부터 잘게 진동하는 모양(sin 5θ) 순으로 줄 세워져 있어서, 앞쪽 몇 개의 계수만 남기고 뒤쪽을 버리면 잘게 진동하는 성분부터 사라진다. 위 그림에서 sin 3개만으로 계단의 큰 모양이 살아났듯, 함수의 대체적인 윤곽만 남는 것이다. 이것이 <strong>저주파 근사</strong>다.
</p>

<div class="callout callout-info">
<div class="callout-title">basis가 뭔가: 함수 공간의 좌표축</div>
<p>3차원 벡터 <b>v</b> = (3, 2, 5)는 사실 "x축 방향으로 3, y축 방향으로 2, z축 방향으로 5만큼 가서 더하라"는 뜻이다. 즉 <b>v</b> = 3·<b>x̂</b> + 2·<b>ŷ</b> + 5·<b>ẑ</b>, <strong>기준 축들의 가중합</strong>이다. 이때 x̂·ŷ·ẑ처럼 "다른 모든 것을 조합해 만들 때 쓰는 기준 축의 집합"이 <strong>basis(기저)</strong>고, (3, 2, 5)라는 좌표는 각 축에 곱하는 가중치다. 축이 먼저 약속돼 있어야 벡터를 숫자 3개로 줄여 말할 수 있다.</p>
<p>함수도 벡터처럼 다룰 수 있다. "구면 위의 함수"들이 사는 공간에서 <i>Y</i><sub>lm</sub> 하나하나가 좌표축이고, SH 계수 9개가 그 축들에 대한 좌표다. "SH basis 함수들의 가중합"은 벡터의 3·<b>x̂</b> + 2·<b>ŷ</b> + 5·<b>ẑ</b>와 완전히 같은 문장인 셈이다. 사실 큐브맵도 basis다. "이 텍셀 방향만 1이고 나머지는 0"인 함수 수천 개가 축이고 텍셀 값들이 좌표다. SH는 같은 함수를 "평균 밝기 축(<i>Y</i><sub>00</sub>), 어느 쪽이 밝은가 축 3개(<i>Y</i><sub>1m</sub>), 더 잘게 나뉜 패턴 축 5개(<i>Y</i><sub>2m</sub>)"라는 <strong>훨씬 적은 축으로 표현하는 다른 좌표계</strong>일 뿐이다.</p>
<p>축들이 서로 <strong>수직(정규직교)</strong>이라는 것이 핵심 성질이다. 벡터의 x성분을 <b>v</b>·<b>x̂</b> 내적 한 번으로 꺼내듯, 어떤 축의 좌표는 그 축과의 내적 한 번으로 나온다. 함수에서는 그 내적이 적분이고, 이것이 바로 프로젝션이다. 그리고 축 몇 개를 버려도 남은 좌표는 다시 계산할 필요가 없어서, 9개에서 잘라도 그 9개가 그대로 최적 근사가 된다(→ 02장).</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 관점으로 아래 그림을 보자. 방향은 원래 구면 위의 2차원이지만 종이에 그리기 쉽게, <strong>일단 방향을 각도 θ 하나로 줄인 1차원 기준으로만 생각해 보자</strong>. <strong>①</strong> 큐브맵은 "방향 → 값" 표다. 반원 호의 조각 색이 각 방향에서 들어오는 빛이고(지면 바운스는 갈색, 하늘은 파랑, 태양은 노랑), 아래 표는 그 색을 각도 순서대로 일렬로 늘어놓은 것이다. <strong>칸의 색이 곧 저장된 값이다.</strong> 방향마다 텍셀을 하나씩 두고 값을 전부 적어 넣는, 함수를 그대로 저장하는 방식이다. 방금 basis 언어로 하면 "이 텍셀 방향만 1인 함수" 수천 개를 축으로 쓰는 좌표계라서, 좌표(텍셀 값)도 수천 개가 필요하다. <strong>②</strong> 그런데 이 표를 각도 축 위에 펼쳐 밝기를 높이로 그리면 결국 하나의 함수 그래프다. 태양의 노란 칸이 있던 자리(θ ≈ 135°)에서 곡선이 스파이크로 치솟는다. 저장해야 하는 것이 "칸칸이 적힌 값들"이 아니라 <strong>"곡선의 모양"</strong>이라는 것이 보인다. <strong>③</strong> 곡선의 모양이라면 방금 푸리에 급수에서 했던 일을 그대로 할 수 있다. SH 축으로 갈아타서 계수 9개만 남기는 것이다. 태양처럼 날카로운 스파이크는 뭉개지지만, 완만한 밝기 분포는 숫자 9개에 담긴다.
</p>

<div class="scene-fig" id="sh-table-fig">
<svg viewBox="0 0 780 265" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs>
<marker id="shfig-arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7e8295"/></marker>
</defs>

<!-- ① 표로 저장 (큐브맵) -->

<text x="125" y="26" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">① 그대로 저장: 방향마다 텍셀 하나</text>
<line x1="40" y1="158" x2="210" y2="158" stroke="#4a4a5c" stroke-width="1.4"/>
<path d="M 47 158 A 78 78 0 0 1 49.7 137.8"   fill="none" stroke="#7c4a2a" stroke-width="14"/>
<path d="M 49.7 137.8 A 78 78 0 0 1 57.5 119"  fill="none" stroke="#a86a32" stroke-width="14"/>
<path d="M 57.5 119 A 78 78 0 0 1 69.9 102.9"  fill="none" stroke="#5b6b8c" stroke-width="14"/>
<path d="M 69.9 102.9 A 78 78 0 0 1 86 90.5"   fill="none" stroke="#4f74b8" stroke-width="14"/>
<path d="M 86 90.5 A 78 78 0 0 1 104.8 82.7"   fill="none" stroke="#5b8fd6" stroke-width="14"/>
<path d="M 104.8 82.7 A 78 78 0 0 1 125 80"    fill="none" stroke="#74a8e8" stroke-width="14"/>
<path d="M 125 80 A 78 78 0 0 1 145.2 82.7"    fill="none" stroke="#86b8f0" stroke-width="14"/>
<path d="M 145.2 82.7 A 78 78 0 0 1 164 90.5"  fill="none" stroke="#9cc6f2" stroke-width="14"/>
<path d="M 164 90.5 A 78 78 0 0 1 180.1 102.9" fill="none" stroke="#ffd34d" stroke-width="14"/>
<path d="M 180.1 102.9 A 78 78 0 0 1 192.5 119" fill="none" stroke="#ffb020" stroke-width="14"/>
<path d="M 192.5 119 A 78 78 0 0 1 200.3 137.8" fill="none" stroke="#f2874a" stroke-width="14"/>
<path d="M 200.3 137.8 A 78 78 0 0 1 203 158"  fill="none" stroke="#c25e35" stroke-width="14"/>
<circle cx="125" cy="158" r="3.5" fill="#414455"/>
<line x1="125" y1="158" x2="184.8" y2="107.9" stroke="#7e8295" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="160" y="126" fill="#7e8295" font-size="10" font-style="italic">θ</text>
<text x="40" y="172" fill="#7e8295" font-size="9" text-anchor="middle">0°</text>
<text x="125" y="70" fill="#7e8295" font-size="9" text-anchor="middle">90°</text>
<text x="210" y="172" fill="#7e8295" font-size="9" text-anchor="middle">180°</text>
<rect x="40"  y="192" width="14" height="13" fill="#7c4a2a"/>
<rect x="54"  y="192" width="14" height="13" fill="#a86a32"/>
<rect x="68"  y="192" width="14" height="13" fill="#5b6b8c"/>
<rect x="82"  y="192" width="14" height="13" fill="#4f74b8"/>
<rect x="96"  y="192" width="14" height="13" fill="#5b8fd6"/>
<rect x="110" y="192" width="14" height="13" fill="#74a8e8"/>
<rect x="124" y="192" width="14" height="13" fill="#86b8f0"/>
<rect x="138" y="192" width="14" height="13" fill="#9cc6f2"/>
<rect x="152" y="192" width="14" height="13" fill="#ffd34d"/>
<rect x="166" y="192" width="14" height="13" fill="#ffb020"/>
<rect x="180" y="192" width="14" height="13" fill="#f2874a"/>
<rect x="194" y="192" width="14" height="13" fill="#c25e35"/>
<rect x="40" y="192" width="168" height="13" fill="none" stroke="#4a4a5c" stroke-width="0.8"/>
<text x="125" y="222" fill="#7e8295" font-size="9.5" text-anchor="middle">θ → 값 표 = 텍스처(큐브맵)</text>

<line x1="240" y1="130" x2="272" y2="130" stroke="#7e8295" stroke-width="1.2" marker-end="url(#shfig-arr)"/>
<text x="256" y="120" fill="#7e8295" font-size="9" text-anchor="middle">함수로 보면</text>

<!-- ② 함수 그래프 -->

<text x="390" y="26" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">② 같은 데이터 = θ의 함수</text>
<line x1="290" y1="200" x2="490" y2="200" stroke="#4a4a5c" stroke-width="1.4"/>
<line x1="290" y1="200" x2="290" y2="70" stroke="#4a4a5c" stroke-width="1.4"/>
<text x="286" y="64" fill="#7e8295" font-size="9" text-anchor="end">밝기</text>
<text x="292" y="214" fill="#7e8295" font-size="9" text-anchor="middle">0°</text>
<text x="390" y="214" fill="#7e8295" font-size="9" text-anchor="middle">90°</text>
<text x="486" y="214" fill="#7e8295" font-size="9" text-anchor="middle">180°</text>
<path d="M 290 162 L 300 158 L 308 165 L 318 156 L 326 162 C 336 150, 346 142, 356 138 L 364 142 L 372 134 L 382 138 C 392 132, 402 130, 412 132 L 420 128 L 428 132 L 436 120 L 442 82 L 448 78 L 452 96 L 458 130 L 466 142 L 474 150 L 482 154 L 490 158" fill="none" stroke="#d6304a" stroke-width="2"/>
<text x="316" y="140" fill="#d6304a" font-size="10" font-style="italic">f(θ)</text>
<text x="452" y="70" fill="#b07d00" font-size="9" text-anchor="middle">태양</text>

<line x1="508" y1="130" x2="534" y2="130" stroke="#7e8295" stroke-width="1.2" marker-end="url(#shfig-arr)"/>
<text x="521" y="120" fill="#7e8295" font-size="9" text-anchor="middle">저주파만</text>

<!-- ③ SH 근사 -->

<text x="650" y="26" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">③ SH = 함수의 저주파 근사</text>
<line x1="550" y1="200" x2="750" y2="200" stroke="#4a4a5c" stroke-width="1.4"/>
<line x1="550" y1="200" x2="550" y2="70" stroke="#4a4a5c" stroke-width="1.4"/>
<text x="552" y="214" fill="#7e8295" font-size="9" text-anchor="middle">0°</text>
<text x="650" y="214" fill="#7e8295" font-size="9" text-anchor="middle">90°</text>
<text x="746" y="214" fill="#7e8295" font-size="9" text-anchor="middle">180°</text>
<path d="M 550 162 L 560 158 L 568 165 L 578 156 L 586 162 C 596 150, 606 142, 616 138 L 624 142 L 632 134 L 642 138 C 652 132, 662 130, 672 132 L 680 128 L 688 132 L 696 120 L 702 82 L 708 78 L 712 96 L 718 130 L 726 142 L 734 150 L 742 154 L 750 158" fill="none" stroke="#7e8295" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.55"/>
<path d="M 550 160 C 565 156, 580 148, 596 142 C 612 136, 622 134, 634 133 C 650 131, 664 120, 678 106 C 690 96, 698 98, 706 114 C 714 132, 720 154, 728 166 C 734 172, 742 166, 750 160" fill="none" stroke="#4338ca" stroke-width="2.6"/>
<text x="610" y="112" fill="#4338ca" font-size="10" font-weight="600">SH 근사</text>
<rect x="604" y="224" width="11" height="11" fill="#4338ca" opacity="1"/>
<rect x="618" y="224" width="11" height="11" fill="#4338ca" opacity="0.85"/>
<rect x="632" y="224" width="11" height="11" fill="#4338ca" opacity="0.7"/>
<rect x="646" y="224" width="11" height="11" fill="#4338ca" opacity="0.6"/>
<rect x="660" y="224" width="11" height="11" fill="#4338ca" opacity="0.5"/>
<rect x="674" y="224" width="11" height="11" fill="#4338ca" opacity="0.42"/>
<rect x="688" y="224" width="11" height="11" fill="#4338ca" opacity="0.36"/>
<rect x="702" y="224" width="11" height="11" fill="#4338ca" opacity="0.3"/>
<rect x="716" y="224" width="11" height="11" fill="#4338ca" opacity="0.26"/>
<text x="665" y="253" fill="#7e8295" font-size="9.5" text-anchor="middle">계수 9개 (L2)</text>
</svg>

<div class="scene-cap">같은 데이터를 세 가지 방식으로 본 것이다: 방향별 표(큐브맵) → 각도의 함수 → 계수 9개짜리 저주파 근사. 오른쪽에서 태양 스파이크가 뭉개진 자리는 04장의 ringing 이야기로 이어진다. 실제 방향은 구면 위의 2차원(θ, φ)이라 basis도 sin(kθ)가 아니라 두 각도의 함수 <i>Y</i><sub>lm</sub>(θ, φ)이고, 계수 9개는 어떤 방향 구간의 값이 아니라 <strong>구면 전체를 덮는 모양 9개에 곱하는 가중치</strong>다. RGB는 채널마다 9개씩 따로 저장한다(합 27개).</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
잠깐 "구면 위의 2차원(θ, φ)"을 그림으로 짚고 가자. 방향 하나는 원점에서 쏜 화살표, 즉 단위 구면 위의 점 하나다. 그리고 구면 위의 점은 지구 위 위치를 위도·경도 두 각도로 말하듯 <strong>각도 두 개면 정해진다</strong>. 아래 수식에 나오는 ω는 이 (θ, φ) 방향 하나를 뭉뚱그려 쓰는 기호다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 300" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace" role="img" aria-label="구면 위의 점이 두 각도로 정해지는 원리. 왼쪽은 극축에서 내려온 각 세타와 적도를 따라 돈 각 파이, 오른쪽은 지구의 위도 경도 비유">
<defs>
<marker id="shsa-arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7e8295"/></marker>
<marker id="shsa-acc" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker>
</defs>

<!-- 왼쪽: 구면 좌표 -->

<text x="230" y="32" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">① 방향 = 구면 위의 점 = 각도 두 개</text>
<circle cx="230" cy="160" r="95" fill="none" stroke="#4a4a5c" stroke-width="1.2"/>
<ellipse cx="230" cy="160" rx="95" ry="26" fill="none" stroke="#d0d3de" stroke-width="1"/>
<ellipse cx="230" cy="160" rx="26" ry="95" fill="none" stroke="#d0d3de" stroke-width="1"/>
<line x1="230" y1="160" x2="230" y2="48" stroke="#7e8295" stroke-width="1.2" marker-end="url(#shsa-arr)"/>
<text x="240" y="56" fill="#7e8295" font-size="10">z</text>
<line x1="230" y1="160" x2="150" y2="172" stroke="#7e8295" stroke-width="1" stroke-dasharray="3 3"/>
<text x="140" y="190" fill="#7e8295" font-size="8" text-anchor="middle">기준 방향 (φ=0)</text>
<line x1="230" y1="160" x2="300" y2="95" stroke="#4338ca" stroke-width="2" marker-end="url(#shsa-acc)"/>
<text x="306" y="86" fill="#4338ca" font-size="10" font-weight="600">방향 ω</text>
<line x1="300" y1="95" x2="300" y2="178" stroke="#7e8295" stroke-width="1" stroke-dasharray="3 3"/>
<line x1="230" y1="160" x2="300" y2="178" stroke="#7e8295" stroke-width="1" stroke-dasharray="3 3"/>
<path d="M 230 126 A 34 34 0 0 1 255 137" fill="none" stroke="#4338ca" stroke-width="1.3"/>
<text x="246" y="116" fill="#4338ca" font-size="10" font-style="italic">θ</text>
<path d="M 185.5 167 Q 230 178 273.6 171" fill="none" stroke="#b07d00" stroke-width="1.3"/>
<text x="228" y="192" fill="#b07d00" font-size="10" font-style="italic">φ</text>
<circle cx="230" cy="160" r="2.5" fill="#414455"/>

<!-- 오른쪽: 지구 비유 -->

<text x="590" y="32" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">② 지구의 위도·경도와 같은 원리</text>
<circle cx="590" cy="160" r="80" fill="none" stroke="#4a4a5c" stroke-width="1.2"/>
<ellipse cx="590" cy="160" rx="80" ry="20" fill="none" stroke="#d0d3de" stroke-width="1"/>
<ellipse cx="590" cy="122" rx="70" ry="14" fill="none" stroke="#d0d3de" stroke-width="1"/>
<ellipse cx="590" cy="198" rx="70" ry="14" fill="none" stroke="#d0d3de" stroke-width="1"/>
<ellipse cx="590" cy="160" rx="24" ry="80" fill="none" stroke="#d0d3de" stroke-width="1"/>
<ellipse cx="590" cy="160" rx="56" ry="80" fill="none" stroke="#d0d3de" stroke-width="1"/>
<ellipse cx="590" cy="110" rx="62" ry="16" fill="none" stroke="#d6304a" stroke-width="0.9" stroke-dasharray="3 3" opacity="0.6"/>
<circle cx="632" cy="110" r="4" fill="#d6304a"/>
<text x="644" y="102" fill="#414455" font-size="8.5">위도 37.5°</text>
<text x="644" y="116" fill="#414455" font-size="8.5">경도 127°</text>
<text x="590" y="266" fill="#7e8295" font-size="9.5" text-anchor="middle">각도 두 개면 지구 위 어디든 하나로 정해진다</text>
</svg>

<div class="scene-cap">방향 하나는 구면 위의 점 하나이고, 구면 위의 점은 각도 두 개로 짚어진다. 극축(z)에서 내려온 각 <strong>θ</strong>(위도 역할)와, 기준 방향에서 적도를 따라 돈 각 <strong>φ</strong>(경도 역할)다. 그래서 "모든 방향에 대한 빛"은 두 변수의 함수 f(θ, φ)이고, sin(kθ) 같은 1차원 basis 대신 두 각도의 함수 <i>Y</i><sub>lm</sub>(θ, φ)이 필요해진다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
우리가 담으려는 것은 3D 공간의 라이팅, 즉 방금 본 위도·경도처럼 각도 두 개로 정해지는 <strong>방향의 함수</strong>다. 그러니 basis도 sin(kθ) 같은 1차원 파형이 아니라, <strong>구면 위의 모든 방향에 숫자 하나씩을 매기는 두 각도의 함수</strong> <i>Y</i><sub>lm</sub>(θ, φ)이어야 한다. sin(kθ)가 선 위의 각 점에 값을 매기고 그것을 그래프의 높이로 그렸다면, 구면 함수는 값을 구면에 색으로 칠하거나 값의 크기를 그 방향의 반지름으로 부풀려 로브 모양으로 그린다. 가장 단순한 예로 <i>Y</i><sub>1,0</sub> = 0.49·z를 골라 직접 그려 보자. 첨자 (1, 0)은 "1번 묶음에서 z축 방향을 맡은 축"이라는 주소다. 첨자를 매기는 정확한 규칙은 잠시 뒤에 정리하니, 지금은 <strong>값이 높이 z에 비례하는 가장 단순한 구면 함수</strong>라는 것만 보면 된다. 방향은 단위 벡터라 z는 −1에서 +1 사이이고, 값은 0.49에 z를 곱한 것이다. 북극(z = +1)에서 +0.49, 비스듬한 45° 방향(z ≈ 0.71)에서 +0.35, 적도(z = 0)에서 0, 남극(z = −1)에서 −0.49. 이걸 그려 보면 뒤에 나올 "아령 로브"가 어떻게 만들어지는지 보인다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 300" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace" role="img" aria-label="구면 함수가 로브 모양이 되는 과정. 구면에 값을 칠하고, 값의 크기를 반지름으로 부풀리면 아령 모양이 된다">
<defs>
<linearGradient id="shlb-grad" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#4338ca"/>
<stop offset="0.5" stop-color="#f2f3f8"/>
<stop offset="1" stop-color="#d6304a"/>
</linearGradient>
<marker id="shlb-arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7e8295"/></marker>
</defs>

<!-- ① 구면에 값을 칠한다 -->

<text x="140" y="36" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">① 구면에 값을 칠한다</text>
<text x="140" y="54" fill="#7e8295" font-size="9" text-anchor="middle">Y<tspan font-size="7" dy="2">1,0</tspan><tspan font-size="9" dy="-2">(θ, φ) = 0.49·z</tspan></text>
<circle cx="140" cy="165" r="62" fill="url(#shlb-grad)" opacity="0.85" stroke="#4a4a5c" stroke-width="1.2"/>
<line x1="80" y1="165" x2="200" y2="165" stroke="#7e8295" stroke-width="1" stroke-dasharray="3 3"/>
<line x1="97" y1="121" x2="183" y2="121" stroke="#7e8295" stroke-width="0.8" stroke-dasharray="2 3"/>
<text x="188" y="124" fill="#414455" font-size="7.5" text-anchor="start">z=0.71: +0.35</text>
<text x="140" y="94" fill="#4338ca" font-size="8.5" text-anchor="middle">z = +1 방향: 값 +0.49</text>
<text x="140" y="181" fill="#414455" font-size="8" text-anchor="middle">적도: 값 0</text>
<text x="140" y="244" fill="#d6304a" font-size="8.5" text-anchor="middle">z = −1 방향: 값 −0.49</text>
<text x="140" y="268" fill="#7e8295" font-size="8.5" text-anchor="middle">파랑 = 양수 · 빨강 = 음수 · 흰색 = 0</text>

<line x1="222" y1="165" x2="330" y2="165" stroke="#7e8295" stroke-width="1.1" marker-end="url(#shlb-arr)"/>
<text x="276" y="156" fill="#7e8295" font-size="8.5" text-anchor="middle">값 → 길이</text>

<!-- ② 값의 크기를 반지름으로 -->

<text x="400" y="36" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">② 값의 크기를 반지름으로</text>
<text x="400" y="54" fill="#7e8295" font-size="9" text-anchor="middle">극 쪽일수록 길게, 적도에선 0</text>
<line x1="400" y1="165" x2="400" y2="121" stroke="#4338ca" stroke-width="2"/>
<line x1="400" y1="165" x2="419" y2="132" stroke="#4338ca" stroke-width="1.6"/>
<line x1="400" y1="165" x2="381" y2="132" stroke="#4338ca" stroke-width="1.6"/>
<line x1="400" y1="165" x2="419" y2="154" stroke="#4338ca" stroke-width="1.3"/>
<line x1="400" y1="165" x2="381" y2="154" stroke="#4338ca" stroke-width="1.3"/>
<line x1="400" y1="165" x2="407.5" y2="163.7" stroke="#4338ca" stroke-width="1"/>
<line x1="400" y1="165" x2="392.5" y2="163.7" stroke="#4338ca" stroke-width="1"/>
<line x1="400" y1="165" x2="407.5" y2="166.3" stroke="#d6304a" stroke-width="1"/>
<line x1="400" y1="165" x2="392.5" y2="166.3" stroke="#d6304a" stroke-width="1"/>
<line x1="400" y1="165" x2="419" y2="176" stroke="#d6304a" stroke-width="1.3"/>
<line x1="400" y1="165" x2="381" y2="176" stroke="#d6304a" stroke-width="1.3"/>
<line x1="400" y1="165" x2="419" y2="198" stroke="#d6304a" stroke-width="1.6"/>
<line x1="400" y1="165" x2="381" y2="198" stroke="#d6304a" stroke-width="1.6"/>
<line x1="400" y1="165" x2="400" y2="209" stroke="#d6304a" stroke-width="2"/>
<circle cx="400" cy="143" r="22" fill="none" stroke="#4338ca" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>
<circle cx="400" cy="187" r="22" fill="none" stroke="#d6304a" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>
<circle cx="400" cy="165" r="2.5" fill="#414455"/>
<text x="400" y="240" fill="#7e8295" font-size="8.5" text-anchor="middle">적도 방향: 값 0 → 반지름 0 (잘록한 허리)</text>

<line x1="452" y1="165" x2="592" y2="165" stroke="#7e8295" stroke-width="1.1" marker-end="url(#shlb-arr)"/>
<text x="522" y="156" fill="#7e8295" font-size="8.5" text-anchor="middle">윤곽을 채우면</text>

<!-- ③ 로브 완성 -->

<text x="650" y="36" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">③ 피라미드 그림의 로브</text>
<text x="650" y="54" fill="#7e8295" font-size="9" text-anchor="middle">= 구면에 칠한 패턴을 부풀린 것</text>
<circle cx="650" cy="141" r="24" fill="#4338ca" opacity="0.85"/>
<circle cx="650" cy="189" r="24" fill="#d6304a" opacity="0.8"/>
<text x="650" y="147" fill="#ffffff" font-size="14" text-anchor="middle">+</text>
<text x="650" y="195" fill="#ffffff" font-size="14" text-anchor="middle">−</text>
<line x1="656" y1="165" x2="690" y2="166" stroke="#7e8295" stroke-width="0.9"/>
<text x="694" y="169" fill="#7e8295" font-size="8.5" text-anchor="start">허리 = 값 0</text>
</svg>

<div class="scene-cap">basis가 "두 각도의 함수"라는 말의 뜻. <i>Y</i><sub>1,0</sub> = 0.49·z는 구면의 각 방향에 숫자를 매긴다 — 북극에서 +0.49, 적도에서 0, 남극에서 −0.49(①). 이 값의 크기를 그 방향의 반지름으로 부풀려 그리면(②) 값이 0인 적도가 허리처럼 잘록해지고, 위(+)·아래(−) 두 로브가 남는다(③). 두 로브는 별개의 덩어리가 아니라 <strong>하나의 기울기의 양 끝</strong>이다. 함수 자체는 +0.49에서 −0.49로 부드럽게 미끄러지는 한 장의 분포인데, 절댓값을 반지름으로 그리는 규칙 탓에 값이 0을 지나는 허리가 홀쭉해져 둘로 나뉘어 보일 뿐이고, 잃어버린 부호는 색(남색 +, 적색 −)으로 표시한다. 뒤에 나올 basis 피라미드 그림의 아령·클로버가 전부 이렇게 그린 것이다. 클로버는 구면을 +−+− 네 구역으로 칠한 패턴을 부풀린 결과다.</div>
</div>

<div class="callout callout-info">
<div class="callout-title">0.49는 누가 정한 숫자인가</div>
<p><i>Y</i><sub>1,0</sub> 앞의 0.49(정확히는 0.488603 = √(3/4π))는 SH를 만든 사람이 임의로 고른 값이 아니다. 벡터의 축을 길이 1짜리 단위 벡터 x̂·ŷ·ẑ로 맞춰 쓰듯, basis 함수도 <strong>"제곱을 구면 전체에서 적분하면 정확히 1"이 되도록 배율을 맞춰 둔다</strong>(정규화). z라는 모양에 이 조건을 적용하면 배율이 √(3/4π)로 유일하게 결정된다. 축의 길이가 전부 1이어야 02장에서 볼 "적분 = 내적"이 보정 계수 없이 성립하기 때문에 꼭 필요한 약속이다. <i>Y</i><sub>0,0</sub> = 0.282095 = 1/(2√π)도 같은 조건에서 나온 값이다. 코드마다 박혀 있는 <code>0.488603f</code>가 바로 이것이고, 언리얼도 이 값을 일반 공식으로 직접 계산해 테이블에 채운다(<code>SHMath.cpp</code>의 <code>InitSHTables</code>).</p>
<p>밴드 2의 상수가 1.09·0.32·0.55로 제각각인 것도 같은 규칙의 결과다. 배율은 "1 ÷ 그 다항식의 원래 크기"인데, 밴드 1의 x·y·z는 같은 아령을 축만 바꾼 것이라 원래 크기가 같아 셋 다 0.49였고, 밴드 2는 모양이 세 종류라 배율도 세 가지가 된다. 예컨대 xy는 x²−y²와 같은 클로버를 45° 돌린 것인데 다항식의 원래 크기가 딱 절반이라, 배율이 정확히 두 배다(1.092548 = 2 × 0.546274). 축대칭인 3z²−1은 자기만의 값 √(5/16π) = 0.315392를 갖는다.</p>
</div>

<div class="formula"><i>f</i>(ω) ≈ Σ<sub>l</sub> Σ<sub>m</sub> <i>f</i><sub>lm</sub> · <i>Y</i><sub>lm</sub>(ω)        ← 재구성: 계수 × basis의 합
<i>f</i><sub>lm</sub> = ∫ <i>f</i>(ω) · <i>Y</i><sub>lm</sub>(ω) dω           ← 프로젝션: 구면 적분 (basis와의 내적)</div>

<p style="color:var(--text2);line-height:1.85;">
기호부터 풀어 두자. <i>Y</i>는 구면 조화 함수를 나타내는 관례적인 문자다. 벡터의 축을 x̂·ŷ·ẑ로 쓰듯, 구면 함수 공간의 축은 전통적으로 <i>Y</i>로 쓴다. 아래 첨자 <i>l</i>과 <i>m</i>은 축 하나하나의 주소다. 첫 번째 <i>l</i>은 <strong>밴드(band)</strong> 번호로, 그 축이 얼마나 잘게 진동하는 모양인지를 나타낸다(<i>l</i> = 0, 1, 2, …). 두 번째 <i>m</i>은 같은 밴드 안에서 어느 방향을 향한 모양인지 구분하는 번호로, 밴드 <i>l</i>에는 <i>m</i> = −<i>l</i> … +<i>l</i>의 2<i>l</i>+1가지가 있다. 그래서 <i>Y</i><sub>1,0</sub>은 "밴드 1에서 z축 방향을 맡은 축"이고, <i>Y</i><sub>2m</sub>처럼 <i>m</i>을 숫자로 안 박고 남겨 쓰면 "밴드 2에 속한 다섯 축(<i>m</i> = −2 … +2) 전부"를 뭉뚱그려 가리키는 것이다. 위 수식의 계수 <i>f</i><sub>lm</sub>도 같은 주소 체계다. "축 <i>Y</i><sub>lm</sub>에 대한 좌표"라는 뜻이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
밴드가 높을수록 구면에서 더 빠르게 진동하는, 즉 더 높은 "각 주파수"를 담당하는 함수다. 밴드 0부터 <i>n</i>−1까지 쓰는 것을 <strong>order n</strong>이라 하고, 계수 개수는 1 + 3 + 5 + … = <i>n</i>²이 된다.
</p>

<div class="data-table">
<table>
<tr><th>표기 (밴드 기준)</th><th>UE 표기 (order)</th><th>누적 계수</th><th>RGB 계수</th><th>담는 정보</th></tr>
<tr><td>L0</td><td>1밴드 (order 1)</td><td>1</td><td>3</td><td>평균 (ambient)</td></tr>
<tr><td>L1</td><td>2밴드 (order 2)</td><td>4</td><td>12</td><td>+ 방향성 1차 (어느 쪽이 밝은가)</td></tr>
<tr><td><strong>L2</strong></td><td><strong>3밴드 (order 3)</strong></td><td><strong>9</strong></td><td><strong>27</strong></td><td>+ 방향성 2차 (<strong>업계 표준</strong>)</td></tr>
<tr><td>L3</td><td>4밴드 (order 4)</td><td>16</td><td>48</td><td>+ 3차 (diffuse엔 기여 0, → 04장)</td></tr>
<tr><td>L4</td><td>5밴드 (order 5)</td><td>25</td><td>75</td><td>+ 4차 (diffuse엔 ~4%, → 04장)</td></tr>
</table>
</div>

<div class="callout callout-warn">
<div class="callout-title">L2와 order 3은 같은 것이다</div>
<p>SH 문헌은 표기가 갈린다. 논문은 최고 밴드 번호를 따서 <strong>L2</strong>라 부르고, 언리얼 코드는 밴드 개수를 따서 <strong>3밴드</strong>(order 3, <code>FSHVector3</code>)라 부른다. 같은 9계수다. 심지어 Far Cry 3 발표는 L1(4계수)을 "2nd order SH"라 부른다. 이 글에서는 계수 개수(4개·9개)를 기준으로 읽으면 혼동이 없다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
"구면 조화 함수"라는 이름은 어렵게 들리지만, 렌더링이 쓰는 실수 SH의 낮은 밴드는 <strong>방향 벡터 (x, y, z)의 단순 다항식</strong>이다. 밴드 0은 상수, 밴드 1은 1차식, 밴드 2는 2차식이다. 그게 전부다.
</p>

<div class="formula">밴드 0:  <i>Y</i><sub>00</sub> = 0.282095                        ← 상수 (1/(2√π))
밴드 1:  <i>Y</i><sub>1,−1</sub> <i>Y</i><sub>1,0</sub> <i>Y</i><sub>1,1</sub> = 0.488603 · (y, z, x)   ← 1차식
밴드 2:  <i>Y</i><sub>2,−2</sub> <i>Y</i><sub>2,−1</sub> <i>Y</i><sub>2,1</sub> = 1.092548 · (xy, yz, xz)
         <i>Y</i><sub>2,0</sub> = 0.315392 · (3z² − 1)             ← 2차식
         <i>Y</i><sub>2,2</sub> = 0.546274 · (x² − y²)</div>

<div class="scene-fig">
<svg viewBox="0 0 780 310" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace" role="img" aria-label="SH basis 9개의 생김새 모식도. 밴드 0은 공 모양 1개, 밴드 1은 아령 모양 3개, 밴드 2는 더 잘게 갈라진 로브 5개">
<!-- 범례 -->
<rect x="606" y="44" width="10" height="10" rx="2" fill="#4338ca" opacity="0.85"/>
<text x="622" y="53" fill="#7e8295" font-size="9" text-anchor="start">+ 로브 (함수값 양수인 방향)</text>
<rect x="606" y="62" width="10" height="10" rx="2" fill="#d6304a" opacity="0.8"/>
<text x="622" y="71" fill="#7e8295" font-size="9" text-anchor="start">− 로브 (함수값 음수인 방향)</text>

<!-- 밴드 0 -->

<text x="14" y="56" fill="#414455" font-size="11" font-weight="600">밴드 0</text>
<text x="14" y="71" fill="#7e8295" font-size="9">축 1개 · 평균</text>
<text x="440" y="24" fill="#7e8295" font-size="8.5" text-anchor="middle">Y<tspan font-size="7" dy="2">0,0</tspan></text>
<circle cx="440" cy="60" r="17" fill="#4338ca" opacity="0.85"/>
<text x="440" y="98" fill="#414455" font-size="9" text-anchor="middle">0.282095 (상수)</text>

<!-- 밴드 1 -->

<text x="14" y="146" fill="#414455" font-size="11" font-weight="600">밴드 1</text>
<text x="14" y="161" fill="#7e8295" font-size="9">축 3개 · 어느 쪽이 밝은가</text>
<text x="280" y="114" fill="#7e8295" font-size="8.5" text-anchor="middle">Y<tspan font-size="7" dy="2">1,−1</tspan></text>
<g transform="translate(280,150)">
<ellipse cx="-13" cy="0" rx="11" ry="13" fill="#d6304a" opacity="0.8"/>
<ellipse cx="13" cy="0" rx="11" ry="13" fill="#4338ca" opacity="0.85"/>
</g>
<text x="280" y="190" fill="#414455" font-size="9" text-anchor="middle">0.488603·y</text>
<text x="440" y="114" fill="#7e8295" font-size="8.5" text-anchor="middle">Y<tspan font-size="7" dy="2">1,0</tspan></text>
<g transform="translate(440,150)">
<ellipse cx="0" cy="-13" rx="11" ry="13" fill="#4338ca" opacity="0.85"/>
<ellipse cx="0" cy="13" rx="11" ry="13" fill="#d6304a" opacity="0.8"/>
</g>
<text x="440" y="190" fill="#414455" font-size="9" text-anchor="middle">0.488603·z</text>
<text x="600" y="114" fill="#7e8295" font-size="8.5" text-anchor="middle">Y<tspan font-size="7" dy="2">1,1</tspan></text>
<g transform="translate(600,150)">
<ellipse cx="-6" cy="0" rx="9" ry="11" fill="#d6304a" opacity="0.8"/>
<ellipse cx="6" cy="0" rx="11" ry="13" fill="#4338ca" opacity="0.85"/>
</g>
<text x="600" y="190" fill="#414455" font-size="9" text-anchor="middle">0.488603·x</text>

<!-- 밴드 2 -->

<text x="14" y="246" fill="#414455" font-size="11" font-weight="600">밴드 2</text>
<text x="14" y="261" fill="#7e8295" font-size="9">축 5개 · 더 잘게 나뉜 패턴</text>
<text x="180" y="212" fill="#7e8295" font-size="8.5" text-anchor="middle">Y<tspan font-size="7" dy="2">2,−2</tspan></text>
<g transform="translate(180,250) rotate(45)">
<ellipse cx="0" cy="-14" rx="7" ry="12" fill="#4338ca" opacity="0.85"/>
<ellipse cx="14" cy="0" rx="12" ry="7" fill="#d6304a" opacity="0.8"/>
<ellipse cx="0" cy="14" rx="7" ry="12" fill="#4338ca" opacity="0.85"/>
<ellipse cx="-14" cy="0" rx="12" ry="7" fill="#d6304a" opacity="0.8"/>
</g>
<text x="180" y="290" fill="#414455" font-size="9" text-anchor="middle">1.09·xy</text>
<text x="310" y="212" fill="#7e8295" font-size="8.5" text-anchor="middle">Y<tspan font-size="7" dy="2">2,−1</tspan></text>
<g transform="translate(310,250) scale(0.8,1)">
<ellipse cx="0" cy="-14" rx="7" ry="12" fill="#4338ca" opacity="0.85"/>
<ellipse cx="14" cy="0" rx="12" ry="7" fill="#d6304a" opacity="0.8"/>
<ellipse cx="0" cy="14" rx="7" ry="12" fill="#4338ca" opacity="0.85"/>
<ellipse cx="-14" cy="0" rx="12" ry="7" fill="#d6304a" opacity="0.8"/>
</g>
<text x="310" y="290" fill="#414455" font-size="9" text-anchor="middle">1.09·yz</text>
<text x="440" y="212" fill="#7e8295" font-size="8.5" text-anchor="middle">Y<tspan font-size="7" dy="2">2,0</tspan></text>
<g transform="translate(440,250)">
<ellipse cx="0" cy="-16" rx="8" ry="12" fill="#4338ca" opacity="0.85"/>
<ellipse cx="0" cy="16" rx="8" ry="12" fill="#4338ca" opacity="0.85"/>
<ellipse cx="0" cy="0" rx="17" ry="5" fill="#d6304a" opacity="0.8"/>
</g>
<text x="440" y="290" fill="#414455" font-size="9" text-anchor="middle">0.32·(3z²−1)</text>
<text x="570" y="212" fill="#7e8295" font-size="8.5" text-anchor="middle">Y<tspan font-size="7" dy="2">2,1</tspan></text>
<g transform="translate(570,250) scale(1,0.8)">
<ellipse cx="0" cy="-14" rx="7" ry="12" fill="#4338ca" opacity="0.85"/>
<ellipse cx="14" cy="0" rx="12" ry="7" fill="#d6304a" opacity="0.8"/>
<ellipse cx="0" cy="14" rx="7" ry="12" fill="#4338ca" opacity="0.85"/>
<ellipse cx="-14" cy="0" rx="12" ry="7" fill="#d6304a" opacity="0.8"/>
</g>
<text x="570" y="290" fill="#414455" font-size="9" text-anchor="middle">1.09·xz</text>
<text x="700" y="212" fill="#7e8295" font-size="8.5" text-anchor="middle">Y<tspan font-size="7" dy="2">2,2</tspan></text>
<g transform="translate(700,250)">
<ellipse cx="0" cy="-14" rx="7" ry="12" fill="#d6304a" opacity="0.8"/>
<ellipse cx="14" cy="0" rx="12" ry="7" fill="#4338ca" opacity="0.85"/>
<ellipse cx="0" cy="14" rx="7" ry="12" fill="#d6304a" opacity="0.8"/>
<ellipse cx="-14" cy="0" rx="12" ry="7" fill="#4338ca" opacity="0.85"/>
</g>
<text x="700" y="290" fill="#414455" font-size="9" text-anchor="middle">0.55·(x²−y²)</text>
</svg>

<div class="scene-cap">SH basis 9개의 생김새(모식도). 그리는 방식은 앞의 <i>Y</i><sub>1,0</sub> 그림과 같다 — 구면에 칠한 값의 크기를 반지름으로 부풀린 것이다. 남색 로브는 함수값이 양수인 방향, 적색 로브는 음수인 방향이고, 밴드가 올라갈수록 로브가 더 잘게 갈라진다. 구면에서 "더 빠르게 진동하는" 모양이라는 뜻이다. 이 모양들과 아래 숫자들은 언리얼이 정한 것이 아니라 구면 조화 함수의 정의에서 나오는 만국 공통 값이고(0.282095 = 1/(2√π)), 언리얼은 이 공식을 <code>SHMath.h</code>에 상수로 박아 두었을 뿐이다(→ 05장). 로브의 방향 배치는 지면 관계상 단순화했다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 계수들을 눈에 익혀두면 좋다. 셰이더나 엔진 코드에서 <code>0.282095f</code>, <code>0.488603f</code>가 보이면 그 코드는 SH basis를 평가하고 있는 것이다. 실제로 언리얼 <code>SHMath.h</code>와 <code>SHCommon.ush</code>에는 정확히 이 상수들이 하드코딩되어 있다(→ 05장). basis가 미리 약속된 고정 함수라서 공식을 이렇게 코드에 박아둘 수 있는 것이고, 프로브가 함수 대신 숫자 9개만 저장해도 되는 이유도 여기에 있다. 프로젝션도 간단하다. 방향 ω에서 들어온 radiance를 SH에 누적하려면 그 방향에서 basis 9개를 평가해 radiance를 곱해 더하면 끝이다. 몬테카를로로 광선을 쏘면서 계수 9개를 누적하는 것, 그것이 프로브를 "SH에 굽는" 작업의 전부다.
</p>

<div class="callout callout-purple">
<div class="callout-title">예시: "위는 파란 하늘, 아래는 노란 바닥" 조명을 숫자 9개로</div>
<p>밴드별 역할을 구체적인 조명으로 감 잡아 보자. 위쪽 반구는 파란 하늘, 아래쪽 반구는 노란 바닥 바운스인 조명을 SH로 접으면, 채널별 계수는 대략 이렇게 나온다. B(파랑) 채널은 밴드 0이 중간값(하늘의 평균 기여)이고, 파랑이 위로 갈수록 강하니 <strong>밴드 1의 z 계수가 큰 양수</strong>다. R·G(노랑 = 빨강+초록) 채널은 밴드 0이 중간값이고, 노랑이 아래로 갈수록 강하니 <strong>밴드 1의 z 계수가 음수</strong>다. 좌우·앞뒤로는 대칭이라 x·y 계수는 0이고, 위에서 아래로 부드럽게 바뀌는 조명이라 밴드 2도 거의 0이다.</p>
<p>어떤 방향의 최종 색은 항상 <strong>평균(밴드 0) ± 기울기(밴드 1) ± 패턴(밴드 2)의 합</strong>으로 복원된다. 법선이 위를 보면 B가 커지고 R·G가 줄어 파랗게, 아래를 보면 반대로 노랗게 나온다. 요지는 밴드 1의 숫자 3개가 "3개 방향의 색"이 아니라 <strong>x·y·z 축 방향의 기울기(어느 쪽이 얼마나 더 밝은가)</strong>라는 것이다.</p>
</div>

<span class="section-eyebrow">02 — 세 가지 성질</span>

</div>

# 게임에서 SH가 살아남은 세 가지 성질

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
01장에서 basis가 "함수 공간의 좌표축"이라고 했다. 그런데 구면 함수를 담는 좌표축 세트가 SH만 있는 건 아니다. ambient cube, HL2 basis, spherical Gaussian 같은 경쟁자가 여럿 있었다(→ 10장). 그중에서 SH라는 좌표축에는 다른 basis가 흉내 내기 힘든 수학적 성질이 세 개 있고, 이 셋이 SH를 표준으로 만들었다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">orthonormal</div>
<div class="card-title">① 적분이 내적이 된다</div>
<div class="card-desc">SH의 좌표축들은 서로 수직(정규직교)이다. 그래서 두 구면 함수의 곱을 구면 전체에서 적분한 값이, 두 함수의 좌표(계수)끼리의 단순 내적으로 환원된다. "조명 × BRDF의 반구 적분"이라는 렌더링의 핵심 연산이 dot product 몇 개로 끝난다.</div>
</div>
<div class="card teal">
<div class="card-label">rotation invariant</div>
<div class="card-title">② 회전에 닫혀 있다</div>
<div class="card-desc">함수를 회전시킨 것의 SH 프로젝션 = 프로젝션한 계수를 회전시킨 것. 근사가 회전 방향에 따라 출렁이지 않는다. Sloan은 이를 "조명이 회전해도 aliasing이나 wobbling이 없다"고 표현했다.</div>
</div>
<div class="card gold">
<div class="card-label">zonal harmonics</div>
<div class="card-title">③ 축대칭 함수는 더 싸다</div>
<div class="card-desc">한 축을 중심으로 대칭인 함수는 밴드당 계수 1개(<i>m</i>=0)만 남는데, 이를 zonal harmonics(ZH)라 한다. 코사인 로브가 바로 ZH라서, diffuse 컨볼루션이 밴드별 스칼라 곱으로 끝난다(→ 03장).</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
①이 셰이딩 비용을 결정한다. 두 벡터의 내적을 좌표끼리 곱해 더해서 구하듯(3·1 + 2·0 + 5·2처럼), 축이 서로 수직이면 두 구면 함수의 곱의 적분도 계수끼리 곱해 더한 값과 정확히 같아진다. 그래서 프로브에 들어 있는 조명 SH와 법선 방향 코사인 로브의 SH를 내적하기만 하면 그 표면이 받는 irradiance가 나온다. 반구 적분이 실행 시간에는 아예 없는 것이다. ②는 품질 문제다. 근사 basis가 회전에 닫혀 있지 않으면(예: 방향이 고정된 ambient cube) 오브젝트가 돌 때 조명 오차의 방향이 함께 돌면서 밝기가 출렁인다. SH는 어떤 회전에서도 같은 함수 공간을 근사하므로 이 아티팩트가 원리적으로 없다. ③은 03장의 주인공인 clamped cosine을 다루는 비용을 좌우한다. 축대칭 함수의 회전, 즉 로브를 법선 방향으로 돌려 세우는 일은 대각 행렬 곱 수준으로 싸다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 330" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace" role="img" aria-label="회전 불변성 비교. 조명 로브가 0도, 45도, 90도로 도는 동안 SH 근사는 똑같이 따라 돌지만, 고정축 basis 근사는 45도에서 모양이 달라진다">
<defs>
<marker id="shrot-arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7e8295"/></marker>
</defs>

<!-- 범례 -->

<line x1="24" y1="27" x2="52" y2="27" stroke="#4338ca" stroke-width="2"/>
<text x="58" y="30" fill="#7e8295" font-size="9">실선 = 원본 조명 (코사인 로브)</text>
<line x1="24" y1="43" x2="52" y2="43" stroke="#7e8295" stroke-width="1.8" stroke-dasharray="4 3"/>
<text x="58" y="46" fill="#7e8295" font-size="9">점선 = basis로 만든 근사</text>

<!-- 열 헤더 -->

<text x="240" y="36" fill="#414455" font-size="10" font-weight="600" text-anchor="middle">조명 방향 0°</text>
<text x="440" y="36" fill="#414455" font-size="10" font-weight="600" text-anchor="middle">45°</text>
<text x="640" y="36" fill="#414455" font-size="10" font-weight="600" text-anchor="middle">90°</text>

<!-- 행 1: SH -->

<text x="14" y="95" fill="#414455" font-size="11" font-weight="600">SH</text>
<text x="14" y="110" fill="#7e8295" font-size="9">회전에 닫힘</text>
<circle cx="240" cy="100" r="52" fill="none" stroke="#d0d3de" stroke-width="1"/>
<circle cx="266" cy="100" r="26" fill="rgba(67,56,202,0.10)" stroke="#4338ca" stroke-width="1.8"/>
<circle cx="266" cy="100" r="23" fill="none" stroke="#0a8f72" stroke-width="1.8" stroke-dasharray="4 3"/>
<circle cx="240" cy="100" r="2.5" fill="#414455"/>
<line x1="300" y1="100" x2="380" y2="100" stroke="#7e8295" stroke-width="1.1" marker-end="url(#shrot-arr)"/>
<text x="340" y="92" fill="#7e8295" font-size="9" text-anchor="middle">회전</text>
<circle cx="440" cy="100" r="52" fill="none" stroke="#d0d3de" stroke-width="1"/>
<circle cx="458.4" cy="81.6" r="26" fill="rgba(67,56,202,0.10)" stroke="#4338ca" stroke-width="1.8"/>
<circle cx="458.4" cy="81.6" r="23" fill="none" stroke="#0a8f72" stroke-width="1.8" stroke-dasharray="4 3"/>
<circle cx="440" cy="100" r="2.5" fill="#414455"/>
<line x1="500" y1="100" x2="580" y2="100" stroke="#7e8295" stroke-width="1.1" marker-end="url(#shrot-arr)"/>
<text x="540" y="92" fill="#7e8295" font-size="9" text-anchor="middle">회전</text>
<circle cx="640" cy="100" r="52" fill="none" stroke="#d0d3de" stroke-width="1"/>
<circle cx="640" cy="74" r="26" fill="rgba(67,56,202,0.10)" stroke="#4338ca" stroke-width="1.8"/>
<circle cx="640" cy="74" r="23" fill="none" stroke="#0a8f72" stroke-width="1.8" stroke-dasharray="4 3"/>
<circle cx="640" cy="100" r="2.5" fill="#414455"/>
<text x="440" y="172" fill="#0a8f72" font-size="9.5" text-anchor="middle">근사(점선)가 원본과 함께 통째로 돈다. 오차가 각도와 무관하다</text>

<!-- 행 2: 고정축 basis -->

<text x="14" y="235" fill="#414455" font-size="11" font-weight="600">고정축 basis</text>
<text x="14" y="250" fill="#7e8295" font-size="9">예: ambient cube</text>
<circle cx="240" cy="240" r="52" fill="none" stroke="#d0d3de" stroke-width="1"/>
<line x1="188" y1="240" x2="292" y2="240" stroke="#d0d3de" stroke-width="1"/>
<line x1="240" y1="188" x2="240" y2="292" stroke="#d0d3de" stroke-width="1"/>
<circle cx="266" cy="240" r="26" fill="rgba(67,56,202,0.10)" stroke="#4338ca" stroke-width="1.8"/>
<circle cx="266" cy="240" r="23" fill="none" stroke="#d6304a" stroke-width="1.8" stroke-dasharray="4 3"/>
<circle cx="240" cy="240" r="2.5" fill="#414455"/>
<line x1="300" y1="240" x2="380" y2="240" stroke="#7e8295" stroke-width="1.1" marker-end="url(#shrot-arr)"/>
<circle cx="440" cy="240" r="52" fill="none" stroke="#d0d3de" stroke-width="1"/>
<line x1="388" y1="240" x2="492" y2="240" stroke="#d0d3de" stroke-width="1"/>
<line x1="440" y1="188" x2="440" y2="292" stroke="#d0d3de" stroke-width="1"/>
<circle cx="458.4" cy="221.6" r="26" fill="rgba(67,56,202,0.10)" stroke="#4338ca" stroke-width="1.8"/>
<circle cx="458" cy="240" r="18" fill="none" stroke="#d6304a" stroke-width="1.8" stroke-dasharray="4 3"/>
<circle cx="440" cy="222" r="18" fill="none" stroke="#d6304a" stroke-width="1.8" stroke-dasharray="4 3"/>
<circle cx="440" cy="240" r="2.5" fill="#414455"/>
<text x="440" y="205" fill="#d6304a" font-size="9" text-anchor="middle">불일치!</text>
<line x1="500" y1="240" x2="580" y2="240" stroke="#7e8295" stroke-width="1.1" marker-end="url(#shrot-arr)"/>
<circle cx="640" cy="240" r="52" fill="none" stroke="#d0d3de" stroke-width="1"/>
<line x1="588" y1="240" x2="692" y2="240" stroke="#d0d3de" stroke-width="1"/>
<line x1="640" y1="188" x2="640" y2="292" stroke="#d0d3de" stroke-width="1"/>
<circle cx="640" cy="214" r="26" fill="rgba(67,56,202,0.10)" stroke="#4338ca" stroke-width="1.8"/>
<circle cx="640" cy="217" r="23" fill="none" stroke="#d6304a" stroke-width="1.8" stroke-dasharray="4 3"/>
<circle cx="640" cy="240" r="2.5" fill="#414455"/>
<text x="440" y="316" fill="#d6304a" font-size="9.5" text-anchor="middle">축(십자선)과 맞을 때만 잘 맞고, 어긋난 각도에서 근사 모양이 달라진다 → 도는 동안 밝기가 출렁인다(wobble)</text>
</svg>

<div class="scene-cap">회전 불변성. 원본 조명(실선)이 돌면 SH 근사(위 행 점선)는 계수만 회전해서 똑같은 모양으로 따라 돈다. 반면 축이 고정된 basis(아래 행)는 축 방향과 맞는 0°·90°에서는 잘 맞지만 45°에서는 근사가 두 축으로 갈라져 모양이 달라진다. 오브젝트가 도는 동안 이 오차 변화가 밝기 출렁임으로 보인다. Sloan이 말한 wobbling이 이것이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
실무에서 ②를 쓰는 방향은 보통 반대다. 조명 SH를 회전시키는 대신 <strong>법선을 역회전시켜 SH를 평가</strong>한다. Ramamoorthi &amp; Hanrahan 2001도 "조명 회전은 법선에 역회전을 적용하는 것으로 처리한다"고 쓰고 있다. 계수는 그대로 두고 조회하는 방향만 바꾸는 것이라 비용이 0이다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 260" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace" role="img" aria-label="zonal harmonics 설명. 축대칭 함수는 밴드당 계수 1개만 남고, 임의 방향으로 돌려 세우는 회전이 싸다">
<defs>
<marker id="shzh-arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7e8295"/></marker>
<marker id="shzh-g" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#b07d00"/></marker>
<marker id="shzh-acc" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker>
</defs>

<!-- ① 축대칭 함수 -->

<text x="140" y="30" fill="#414455" font-size="11" font-weight="600" text-anchor="middle">① 축대칭 함수 (예: 코사인 로브)</text>
<line x1="140" y1="52" x2="140" y2="225" stroke="#7e8295" stroke-width="1" stroke-dasharray="4 3"/>
<text x="150" y="60" fill="#7e8295" font-size="8.5">대칭축</text>
<circle cx="140" cy="152" r="38" fill="rgba(67,56,202,0.12)" stroke="#4338ca" stroke-width="1.8"/>
<circle cx="140" cy="190" r="3" fill="#414455"/>
<path d="M 108 205 A 32 9 0 1 0 172 205" fill="none" stroke="#b07d00" stroke-width="1.3" marker-end="url(#shzh-g)"/>
<text x="140" y="234" fill="#414455" font-size="9" text-anchor="middle">축을 중심으로 빙 돌려도 똑같다</text>

<!-- ② 계수가 밴드당 1개로 -->

<text x="400" y="30" fill="#414455" font-size="11" font-weight="600" text-anchor="middle">② 계수가 밴드당 1개로 준다</text>
<text x="290" y="64" fill="#7e8295" font-size="7.5">밴드</text>
<text x="302" y="83.5" fill="#7e8295" font-size="7.5" text-anchor="end">0</text>
<text x="302" y="113.5" fill="#7e8295" font-size="7.5" text-anchor="end">1</text>
<text x="302" y="143.5" fill="#7e8295" font-size="7.5" text-anchor="end">2</text>
<text x="350" y="64" fill="#414455" font-size="8.5" text-anchor="middle">일반 함수: 9개</text>
<rect x="343.5" y="74" width="13" height="13" fill="#7e8295" opacity="0.7"/>
<rect x="326.5" y="104" width="13" height="13" fill="#7e8295" opacity="0.7"/>
<rect x="343.5" y="104" width="13" height="13" fill="#7e8295" opacity="0.7"/>
<rect x="360.5" y="104" width="13" height="13" fill="#7e8295" opacity="0.7"/>
<rect x="309.5" y="134" width="13" height="13" fill="#7e8295" opacity="0.7"/>
<rect x="326.5" y="134" width="13" height="13" fill="#7e8295" opacity="0.7"/>
<rect x="343.5" y="134" width="13" height="13" fill="#7e8295" opacity="0.7"/>
<rect x="360.5" y="134" width="13" height="13" fill="#7e8295" opacity="0.7"/>
<rect x="377.5" y="134" width="13" height="13" fill="#7e8295" opacity="0.7"/>
<line x1="396" y1="120" x2="410" y2="120" stroke="#7e8295" stroke-width="1.1" marker-end="url(#shzh-arr)"/>
<text x="455" y="64" fill="#414455" font-size="8.5" text-anchor="middle">축대칭: 3개</text>
<rect x="445.5" y="70" width="19" height="81" rx="4" fill="none" stroke="#4338ca" stroke-width="1" stroke-dasharray="3 3"/>
<rect x="448.5" y="74" width="13" height="13" fill="#4338ca" opacity="0.85"/>
<rect x="431.5" y="104" width="13" height="13" fill="none" stroke="#d0d3de"/>
<text x="438" y="113.5" fill="#c3c7d4" font-size="7" text-anchor="middle">0</text>
<rect x="448.5" y="104" width="13" height="13" fill="#4338ca" opacity="0.85"/>
<rect x="465.5" y="104" width="13" height="13" fill="none" stroke="#d0d3de"/>
<text x="472" y="113.5" fill="#c3c7d4" font-size="7" text-anchor="middle">0</text>
<rect x="414.5" y="134" width="13" height="13" fill="none" stroke="#d0d3de"/>
<text x="421" y="143.5" fill="#c3c7d4" font-size="7" text-anchor="middle">0</text>
<rect x="431.5" y="134" width="13" height="13" fill="none" stroke="#d0d3de"/>
<text x="438" y="143.5" fill="#c3c7d4" font-size="7" text-anchor="middle">0</text>
<rect x="448.5" y="134" width="13" height="13" fill="#4338ca" opacity="0.85"/>
<rect x="465.5" y="134" width="13" height="13" fill="none" stroke="#d0d3de"/>
<text x="472" y="143.5" fill="#c3c7d4" font-size="7" text-anchor="middle">0</text>
<rect x="482.5" y="134" width="13" height="13" fill="none" stroke="#d0d3de"/>
<text x="489" y="143.5" fill="#c3c7d4" font-size="7" text-anchor="middle">0</text>
<text x="400" y="182" fill="#414455" font-size="9" text-anchor="middle">대칭축과 어긋난 모양(m ≠ 0)의 계수가 전부 0</text>
<text x="400" y="200" fill="#7e8295" font-size="8.5" text-anchor="middle">코사인 로브 → Â<tspan font-size="7" dy="2">0</tspan><tspan dy="-2">, Â</tspan><tspan font-size="7" dy="2">1</tspan><tspan dy="-2">, Â</tspan><tspan font-size="7" dy="2">2</tspan><tspan dy="-2"> 세 개면 끝</tspan></text>

<!-- ③ 회전이 싸다 -->

<text x="650" y="30" fill="#414455" font-size="11" font-weight="600" text-anchor="middle">③ 회전이 싸다</text>
<circle cx="650" cy="155" r="30" fill="none" stroke="#c3c7d4" stroke-width="1.2" stroke-dasharray="4 3"/>
<line x1="650" y1="185" x2="700" y2="135" stroke="#7e8295" stroke-width="1" stroke-dasharray="4 3"/>
<circle cx="671" cy="164" r="30" fill="rgba(67,56,202,0.12)" stroke="#4338ca" stroke-width="1.8"/>
<line x1="694" y1="141" x2="706" y2="129" stroke="#4338ca" stroke-width="1.4" marker-end="url(#shzh-acc)"/>
<text x="712" y="127" fill="#4338ca" font-size="10" font-style="italic">n</text>
<path d="M 652 122 Q 680 112 692 138" fill="none" stroke="#7e8295" stroke-width="1.1" marker-end="url(#shzh-arr)"/>
<circle cx="650" cy="185" r="3" fill="#414455"/>
<text x="650" y="222" fill="#414455" font-size="9" text-anchor="middle">로브를 법선 방향으로 돌려 세운다</text>
<text x="650" y="238" fill="#7e8295" font-size="8.5" text-anchor="middle">축대칭이라 밴드당 곱 몇 번이면 끝</text>
</svg>

<div class="scene-cap">zonal harmonics(ZH). 코사인 로브처럼 한 축을 중심으로 빙 돌려도 똑같은 <strong>축대칭</strong> 함수는(①), SH로 프로젝션하면 대칭축과 어긋난 모양들(m ≠ 0)의 계수가 전부 0이 되어 <strong>밴드당 숫자 1개</strong>만 남는다(②). 03장에서 clamped cosine의 계수가 Â<sub>0</sub>, Â<sub>1</sub>, Â<sub>2</sub>처럼 단일 번호로 불리는 이유다. 그리고 이런 함수를 임의의 방향으로 돌려 세우는 것은 일반 SH 회전보다 훨씬 싸서(③), 셰이딩 때마다 코사인 로브를 법선 방향으로 세우는 비용이 거의 공짜가 된다.</div>
</div>

<span class="section-eyebrow">03 — 왜 9개인가</span>

</div>

# 왜 9개인가: clamped cosine이 low-pass 필터라서

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
이제 핵심 질문이다. 왜 4개도 16개도 아닌 <strong>9개</strong>인가. 답은 2001년 Ramamoorthi &amp; Hanrahan의 "An Efficient Representation for Irradiance Environment Maps"에 있다. 요지는 한 문장이다. <strong>diffuse 표면이 받는 irradiance는 어차피 9계수 이상의 정보를 거의 담고 있지 않다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
표면이 받는 irradiance는 들어오는 radiance에 코사인 가중을 걸어 반구에서 적분한 값이다. 이 연산은 구면 함수끼리의 <strong>컨볼루션</strong>이다. 조명 함수 <i>L</i>에 "법선과의 각도에 대한 max(0, cos θ)"라는 커널(clamped cosine)을 말아 씌운 것이다. 그리고 SH의 컨볼루션 정리에 따라, 컨볼루션은 SH 공간에서 <strong>밴드별 스칼라 곱</strong>이 된다. clamped cosine은 축대칭(ZH)이라 밴드마다 숫자 하나 Â<sub>l</sub>로 표현되기 때문이다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 300" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace" role="img" aria-label="clamped cosine 컨볼루션. 왼쪽은 법선에 가까운 빛일수록 코사인 가중이 커지는 그림, 오른쪽은 조명 스펙트럼에 밴드별 상수를 곱해 고주파가 지워지는 그림">
<defs>
<marker id="shcc-g" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#b07d00"/></marker>
<marker id="shcc-a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker>
<marker id="shcc-x" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7e8295"/></marker>
</defs>

<!-- ① 코사인 가중 -->

<text x="160" y="36" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">① 코사인 가중</text>
<line x1="50" y1="210" x2="285" y2="210" stroke="#4a4a5c" stroke-width="1.6"/>
<line x1="70" y1="218" x2="62" y2="226" stroke="#c3c7d4" stroke-width="1"/>
<line x1="110" y1="218" x2="102" y2="226" stroke="#c3c7d4" stroke-width="1"/>
<line x1="150" y1="218" x2="142" y2="226" stroke="#c3c7d4" stroke-width="1"/>
<line x1="190" y1="218" x2="182" y2="226" stroke="#c3c7d4" stroke-width="1"/>
<line x1="230" y1="218" x2="222" y2="226" stroke="#c3c7d4" stroke-width="1"/>
<path d="M 70 210 A 90 90 0 0 1 250 210" fill="none" stroke="#d0d3de" stroke-width="1" stroke-dasharray="4 3"/>
<circle cx="160" cy="170" r="40" fill="rgba(67,56,202,0.10)" stroke="#4338ca" stroke-width="1.6"/>
<line x1="196" y1="178" x2="232" y2="190" stroke="#4338ca" stroke-width="0.9"/>
<text x="236" y="193" fill="#4338ca" font-size="8.5" text-anchor="start">clamped cosine 로브</text>
<line x1="160" y1="210" x2="160" y2="118" stroke="#414455" stroke-width="1.6" marker-end="url(#shcc-a)"/>
<text x="167" y="122" fill="#414455" font-size="9.5">법선 n</text>
<line x1="160" y1="95" x2="160" y2="124" stroke="#b07d00" stroke-width="2" marker-end="url(#shcc-g)"/>
<text x="170" y="100" fill="#b07d00" font-size="8.5">×1.00</text>
<line x1="86" y1="136" x2="118" y2="168" stroke="#b07d00" stroke-width="1.6" marker-end="url(#shcc-g)"/>
<text x="70" y="130" fill="#b07d00" font-size="8.5">×0.71</text>
<line x1="55" y1="192" x2="105" y2="201" stroke="#b07d00" stroke-width="1.4" marker-end="url(#shcc-g)"/>
<text x="42" y="184" fill="#b07d00" font-size="8.5">×0.17</text>
<line x1="248" y1="258" x2="204" y2="232" stroke="#7e8295" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#shcc-x)"/>
<text x="254" y="264" fill="#7e8295" font-size="8.5">×0 (지평선 아래)</text>
<circle cx="160" cy="210" r="3.5" fill="#414455"/>
<text x="160" y="248" fill="#7e8295" font-size="9" text-anchor="middle">가중치 = cos(법선과의 각도)</text>

<!-- ② 밴드별 곱 -->

<text x="534" y="36" fill="#414455" font-size="11.5" font-weight="600" text-anchor="middle">② SH 공간에서는 밴드별 곱</text>
<text x="400" y="118" fill="#414455" font-size="9" text-anchor="middle">조명 L의 스펙트럼</text>
<rect x="348" y="163" width="16" height="42" fill="#7e8295" opacity="0.75"/>
<rect x="370" y="150" width="16" height="55" fill="#7e8295" opacity="0.75"/>
<rect x="392" y="167" width="16" height="38" fill="#7e8295" opacity="0.75"/>
<rect x="414" y="160" width="16" height="45" fill="#7e8295" opacity="0.75"/>
<rect x="436" y="175" width="16" height="30" fill="#7e8295" opacity="0.75"/>
<text x="467" y="190" fill="#414455" font-size="16" text-anchor="middle">×</text>
<text x="534" y="118" fill="#414455" font-size="9" text-anchor="middle">clamped cosine Â</text>
<rect x="482" y="157" width="16" height="48" fill="#b07d00"/>
<rect x="504" y="173" width="16" height="32" fill="#b07d00"/>
<rect x="526" y="193" width="16" height="12" fill="#b07d00"/>
<rect x="570" y="203" width="16" height="2" fill="#b07d00"/>
<text x="490" y="152" fill="#b07d00" font-size="7.5" text-anchor="middle">π</text>
<text x="512" y="168" fill="#b07d00" font-size="7.5" text-anchor="middle">2π/3</text>
<text x="534" y="188" fill="#b07d00" font-size="7.5" text-anchor="middle">π/4</text>
<text x="556" y="200" fill="#d6304a" font-size="8" font-weight="600" text-anchor="middle">0</text>
<text x="578" y="198" fill="#b07d00" font-size="7.5" text-anchor="middle">−π/24</text>
<text x="601" y="190" fill="#414455" font-size="16" text-anchor="middle">=</text>
<text x="668" y="118" fill="#414455" font-size="9" text-anchor="middle">irradiance의 스펙트럼</text>
<rect x="616" y="163" width="16" height="42" fill="#4338ca"/>
<rect x="638" y="168" width="16" height="37" fill="#4338ca"/>
<rect x="660" y="195" width="16" height="10" fill="#4338ca"/>
<rect x="704" y="204" width="16" height="1" fill="#4338ca"/>
<text x="694" y="152" fill="#d6304a" font-size="8" text-anchor="middle">밴드 3+ 소멸</text>
<line x1="348" y1="205" x2="452" y2="205" stroke="#4a4a5c" stroke-width="1"/>
<line x1="482" y1="205" x2="586" y2="205" stroke="#4a4a5c" stroke-width="1"/>
<line x1="616" y1="205" x2="720" y2="205" stroke="#4a4a5c" stroke-width="1"/>
<text x="356" y="218" fill="#7e8295" font-size="8" text-anchor="middle">0</text>
<text x="378" y="218" fill="#7e8295" font-size="8" text-anchor="middle">1</text>
<text x="400" y="218" fill="#7e8295" font-size="8" text-anchor="middle">2</text>
<text x="422" y="218" fill="#7e8295" font-size="8" text-anchor="middle">3</text>
<text x="444" y="218" fill="#7e8295" font-size="8" text-anchor="middle">4</text>
<text x="490" y="218" fill="#7e8295" font-size="8" text-anchor="middle">0</text>
<text x="512" y="218" fill="#7e8295" font-size="8" text-anchor="middle">1</text>
<text x="534" y="218" fill="#7e8295" font-size="8" text-anchor="middle">2</text>
<text x="556" y="218" fill="#7e8295" font-size="8" text-anchor="middle">3</text>
<text x="578" y="218" fill="#7e8295" font-size="8" text-anchor="middle">4</text>
<text x="624" y="218" fill="#7e8295" font-size="8" text-anchor="middle">0</text>
<text x="646" y="218" fill="#7e8295" font-size="8" text-anchor="middle">1</text>
<text x="668" y="218" fill="#7e8295" font-size="8" text-anchor="middle">2</text>
<text x="690" y="218" fill="#7e8295" font-size="8" text-anchor="middle">3</text>
<text x="712" y="218" fill="#7e8295" font-size="8" text-anchor="middle">4</text>
<text x="534" y="238" fill="#7e8295" font-size="8.5" text-anchor="middle">가로축 = 밴드 번호 l</text>
</svg>

<div class="scene-cap">왼쪽: 표면이 받는 irradiance는 모든 방향의 빛에 "법선과의 각도의 코사인"을 곱해 모은 것이다. 법선 방향 빛은 100%, 45° 빛은 71%, 거의 수평인 빛은 17%, 지평선 아래는 0. 이 가중 모양이 clamped cosine 로브이고, 법선 <b>n</b>을 바꿔 가며 로브를 구면 위에서 굴리며 적분하는 것이 컨볼루션이다. 오른쪽: SH 공간에서 이 컨볼루션은 밴드별 곱이 된다. 조명이 밴드 3에 아무리 큰 성분을 갖고 있어도 Â<sub>3</sub> = 0이 곱해져 사라진다. 커널이 low-pass 필터라는 말의 뜻이다.</div>
</div>

<div class="formula">E(<b>n</b>) = Σ<sub>l</sub> Σ<sub>m</sub> Â<sub>l</sub> · <i>L</i><sub>lm</sub> · <i>Y</i><sub>lm</sub>(<b>n</b>)    ← irradiance = 조명 계수에 밴드별로 Â<sub>l</sub>을 곱해 재구성

Â<sub>0</sub> = π     = 3.141593
Â<sub>1</sub> = 2π/3  = 2.094395
Â<sub>2</sub> = π/4   = 0.785398
Â<sub>3</sub> = 0                     ← *l* > 1인 홀수 밴드는 전부 0
Â<sub>4</sub> = −π/24 = −0.130900
Â<sub>6</sub> = 0.049087              ← 짝수 밴드는 *l*<sup>−5/2</sup>로 급감</div>

<p style="color:var(--text2);line-height:1.85;">
9계수의 근거가 이 수열에 전부 들어 있다. clamped cosine의 SH 계수는 밴드 2까지는 크지만(π, 2π/3, π/4), <strong>밴드 3에서 정확히 0</strong>이 되고, 이후 짝수 밴드만 <i>l</i><sup>−5/2</sup>로 급감하며 남는다(홀수 밴드는 전부 사라진다). 컨볼루션에서 조명의 밴드 <i>l</i> 성분에는 Â<sub>l</sub>이 곱해지므로, <strong>조명이 아무리 고주파여도 irradiance에는 밴드 2 위의 성분이 거의 살아남지 못한다.</strong> clamped cosine 커널이 각 주파수 영역의 강력한 low-pass 필터인 것이다. 고주파 조명 정보는 irradiance에 "없는" 게 아니라 커널이 "지운" 것이라서, 저장하지 않아도 잃는 것이 거의 없다.
</p>

<p style="color:var(--text2);line-height:1.85;">
"거의"가 얼마인지 논문은 수치로 못 박는다. 물리적으로 유효한 <strong>어떤 조명</strong>이 들어와도 9계수 근사의 방향 평균 오차는 <strong>3% 미만</strong>이고, 픽셀 최악 오차는 9%다. 실제 자연 환경맵(Grace Cathedral 등)에서는 평균 <strong>1% 미만</strong>, 최대 5% 미만이었다. 흔히 인용되는 "9계수로 99% 정확"이라는 문장은 후자인 실측 환경맵 평균에서 온 것이다. 같은 해 Basri &amp; Jacobs도 같은 결론을 다른 방법으로 확인했다. 임의 조명 아래 램버시안 반사 함수의 에너지를 SH 부분공간이 얼마나 포착하는지 계산하면:
</p>

<div class="data-table">
<table>
<tr><th>근사</th><th>계수</th><th>커널 에너지 포착률</th><th>증분</th></tr>
<tr><td>L1 (2밴드)</td><td>4</td><td>87.5%</td><td>—</td></tr>
<tr><td><strong>L2 (3밴드)</strong></td><td><strong>9</strong></td><td><strong>99.22%</strong></td><td><strong>+11.7%p</strong></td></tr>
<tr><td>L4 (5밴드)</td><td>25</td><td>99.81%</td><td>+0.59%p (계수는 2.8배)</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
L1 → L2에서 +11.7%p가 뛰고, L2 → L4는 계수를 2.8배로 늘려 +0.6%p를 얻는다. <strong>9계수가 diffuse 조명 근사의 수확 체감 지점이라는 것이 이 표의 결론이고, 업계가 L2에 수렴한 이유의 전부다.</strong>
</p>

<div class="callout callout-purple">
<div class="callout-title">irradiance는 법선의 2차 다항식이다</div>
<p>01장에서 봤듯 밴드 2까지의 basis는 전부 (x, y, z)의 2차 이하 다항식이다. 따라서 9계수 irradiance는 법선 <b>n</b>에 대한 <strong>2차 형식 E(<b>n</b>) = <b>n</b><sup>T</sup>M<b>n</b></strong>(M은 4×4 대칭 행렬)으로 정리된다. 셰이더에서 행렬-벡터 곱 하나로 평가된다는 뜻이다. "이론적으로 충분한 최소 계수"가 하필 "GPU가 가장 잘하는 연산 형태"와 일치한 것도 L2 표준화를 밀어준 실용적 이유다. 언리얼의 <code>GetSkySHDiffuse</code>가 정확히 이 형태다(→ 07장).</p>
</div>

<span class="section-eyebrow">04 — 고차 SH의 함정</span>

</div>

# order를 높이면 좋아지는가: 얻는 것 0, 잃는 것 셋

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
"9개로 99%면, 16개·25개로는 더 좋아지지 않나?"라는 질문에는 용도를 갈라 답해야 한다. <strong>diffuse(irradiance)용이라면 올려도 얻는 것이 거의 없다.</strong> 03장의 수열을 다시 보자. Â<sub>3</sub> = 0이다. 즉 L2에서 L3로 올려도(9 → 16계수) 컨볼루션 결과에는 <strong>더해지는 것이 하나도 없다</strong>. 새로 생긴 밴드 3 계수 7개에는 전부 0이 곱해지기 때문이다. L4까지 가야 Â<sub>4</sub> = −0.1309가 살아나는데, 이는 Â<sub>0</sub> = π의 4% 수준이다. Ramamoorthi &amp; Hanrahan은 후속 논문(JOSA A 2001)에서 이를 "irradiance는 order 2까지만 안정적으로 측정할 수 있다"고 정리했다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>radiance(specular·glossy)용이라면 답이 뒤집힌다.</strong> 광택 반사의 커널은 코사인 로브보다 훨씬 날카롭고, 날카로운 커널은 고주파를 지우지 않는다. Ramamoorthi &amp; Hanrahan의 2002년 후속 연구는 Phong 지수 <i>s</i>인 BRDF를 오차 ε로 담는 데 필요한 order를 <i>F</i> ≈ √(−<i>s</i>·ln ε)로 유도했다. <i>s</i> = 100, ε = 1%면 <strong><i>F</i> ≈ 21, 계수로는 484개</strong>다. SH로 스페큘러를 담는 것이 비실용적인 이유이고, 실시간 렌더링이 스페큘러를 SH가 아니라 prefiltered 큐브맵(언리얼의 reflection capture)으로 처리하는 이유다. 실시간 렌더링에서 SH가 diffuse 전용 도구로 자리 잡은 배경이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그리고 order를 올리는 것은 공짜가 아니다. 잃는 것이 셋 있다.
</p>

<div class="card-grid">
<div class="card coral">
<div class="card-label">ringing</div>
<div class="card-title">① Gibbs 현상</div>
<div class="card-desc">불연속(태양 같은 점광원)을 유한 개 basis로 자르면 경계 주변 값이 물결치듯 넘치고 모자란다. 푸리에 급수의 Gibbs 현상 그대로다. order를 올리면 물결이 좁아질 뿐 사라지지 않는다.</div>
</div>
<div class="card gold">
<div class="card-label">negative lobe</div>
<div class="card-title">② 음수 조명</div>
<div class="card-desc">clamped cosine의 order 3 근사조차 반대극에 크기 1/16의 가짜 로브가 있고, order 5 근사에는 음수 로브가 생긴다. HDR 광원이 곱해지면 화면에 음수 조명(검은 얼룩)으로 나타난다. 고차일수록 HDR에서 더 위험하다.</div>
</div>
<div class="card purple">
<div class="card-label">n² cost</div>
<div class="card-title">③ 제곱으로 늘어나는 비용</div>
<div class="card-desc">계수는 order의 제곱으로 늘어난다. 9 → 16 → 25, RGB면 ×3이다. 프로브 수만 개 × 메모리·대역폭·보간 비용이 전부 제곱으로 늘어난다. VLM처럼 텍스처에 굽는 구조에서는 텍스처 장수가 그대로 늘어난다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
①②의 표준 완화책이 <strong>windowing</strong>이다. 신호처리에서 급하게 자른 필터의 링잉을 죽일 때 쓰는 Hanning·Lanczos 윈도우를 SH 계수에 밴드별로 곱해, 컷오프 근처 밴드를 부드럽게 0으로 눌러 내리는 것이다. 대가는 블러다. Sloan은 "어떤 윈도우 함수를 쓰느냐보다 ringing과 blur를 서로 맞바꿀 수단을 갖는 것이 중요하다"고 정리했다. Unity 라이트 프로브의 "Remove Ringing" 옵션이 이 계열이고, 언리얼은 Lightmass가 Volumetric Lightmap을 구울 때 자동으로 적용한다(→ 05장). 결론을 미리 당기면 이렇다. <strong>diffuse용 SH는 L2가 사실상의 상한이자 최적점이다. 그 위는 얻는 것이 0~0.6%p이고, 잃는 것은 ringing·음수·제곱 비용이다.</strong>
</p>

<span class="section-eyebrow">05 — UE: SHMath 코어</span>

</div>

# 언리얼의 SH 수학 코어: 상한은 3밴드로 못 박혀 있다

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
이제 이론이 언리얼엔진 5.8 코드에 어떻게 박혀 있는지 보자. SH의 근간은 <code>Engine/Source/Runtime/Core/Public/Math/SHMath.h</code>의 템플릿 하나다.
</p>

<div class="code-block"><div class="code-lang">C++ — SHMath.h (핵심 구조)</div><span class="kw">template</span>&lt;<span class="kw">int32</span> Order&gt;
<span class="kw">class</span> <span class="ty">TSHVector</span>
{
    <span class="kw">enum</span> { MaxSHOrder = Order };
    <span class="kw">enum</span> { MaxSHBasis = MaxSHOrder * MaxSHOrder };   <span class="cm">// 계수 개수 = order²</span>
    <span class="kw">enum</span> { NumComponentsPerSIMDVector = <span class="num">4</span> };          <span class="cm">// 4 float SIMD 정렬</span>
    <span class="kw">float</span> V[NumTotalFloats];                          <span class="cm">// 9계수는 12 float로 패딩</span>
    ...
};

<span class="kw">typedef</span> <span class="ty">TSHVector</span><<span class="num">2</span>>    <span class="ty">FSHVector2</span>;      <span class="cm">// 2밴드 = 4계수</span>
<span class="kw">typedef</span> <span class="ty">TSHVector</span><<span class="num">3</span>>    <span class="ty">FSHVector3</span>;      <span class="cm">// 3밴드 = 9계수</span>
<span class="kw">typedef</span> <span class="ty">TSHVectorRGB</span><<span class="num">2</span>> <span class="ty">FSHVectorRGB2</span>;   <span class="cm">// RGB × 4 = 12계수</span>
<span class="kw">typedef</span> <span class="ty">TSHVectorRGB</span><<span class="num">3</span>> <span class="ty">FSHVectorRGB3</span>;   <span class="cm">// RGB × 9 = 27계수</span></div>

<p style="color:var(--text2);line-height:1.85;">
템플릿이라 order를 얼마든지 올릴 수 있어 보이지만, 실제로는 아니다. 정규화 상수 테이블이 <code>NormalizationConstants[9]</code>, <code>BasisL[9]</code>, <code>BasisM[9]</code>로 <strong>9개에 고정</strong>되어 있고(SHMath.cpp), basis 평가의 삼각함수 회피 특수화도 order 2와 3에만 있다. 즉 <strong>엔진 전체가 SH 상한을 3밴드(9계수)로 못 박아 둔 것이다</strong>. 04장의 결론이 자료구조 크기로 굳어 있는 셈이다. order 3 특수화의 하드코딩 상수는 01장에서 본 그 다항식 그대로다.
</p>

<div class="code-block"><div class="code-lang">C++ — SHMath.h (order 3 basis 특수화 = 01장의 다항식)</div>Result.V[<span class="num">0</span>] =  <span class="num">0.282095f</span>;                                    <span class="cm">// band 0 (상수)</span>
Result.V[<span class="num">1</span>] = <span class="num">-0.488603f</span> * Vector.Y;                         <span class="cm">// band 1 (1차식)</span>
Result.V[<span class="num">2</span>] =  <span class="num">0.488603f</span> * Vector.Z;
Result.V[<span class="num">3</span>] = <span class="num">-0.488603f</span> * Vector.X;
Result.V[<span class="num">4</span>] =  <span class="num">1.092548f</span> * (Vector.X * Vector.Y);            <span class="cm">// band 2 (2차식)</span>
Result.V[<span class="num">5</span>] = <span class="num">-1.092548f</span> * (Vector.Y * Vector.Z);
Result.V[<span class="num">6</span>] =  <span class="num">0.315392f</span> * (<span class="num">3.0f</span> * VectorSquared.Z - <span class="num">1.0f</span>);
Result.V[<span class="num">7</span>] = <span class="num">-1.092548f</span> * (Vector.X * Vector.Z);
Result.V[<span class="num">8</span>] =  <span class="num">0.546274f</span> * (VectorSquared.X - VectorSquared.Y);</div>

<p style="color:var(--text2);line-height:1.85;">
03장의 clamped cosine 계수 π, 2π/3, π/4도 코드에 그대로 있다. <code>CalcDiffuseTransfer</code>가 법선 방향으로 코사인 로브를 세우고 밴드별 스케일을 곱하는 함수다.
</p>

<div class="code-block"><div class="code-lang">C++ — SHMath.h CalcDiffuseTransfer (= 03장의 Â 계수)</div><span class="kw">float</span> L0 = UE_PI;              <span class="cm">// A0 = π</span>
<span class="kw">float</span> L1 = <span class="num">2</span> * UE_PI / <span class="num">3</span>;      <span class="cm">// A1 = 2π/3</span>
<span class="kw">float</span> L2 = UE_PI / <span class="num">4</span>;          <span class="cm">// A2 = π/4</span>

<span class="kw">for</span> (<span class="kw">int32</span> BasisIndex = <span class="num">0</span>; BasisIndex < MaxSHBasis; BasisIndex++)
{
<span class="kw">if</span>      (BasisIndex < <span class="num">1</span>) Scale = L0;   <span class="cm">// 계수 0        (band 0)</span>
<span class="kw">else if</span> (BasisIndex < <span class="num">4</span>) Scale = L1;   <span class="cm">// 계수 1..3     (band 1)</span>
<span class="kw">else</span>                     Scale = L2;   <span class="cm">// 계수 4..8     (band 2)</span>
Result.V[BasisIndex] *= Scale;
}</div>

<p style="color:var(--text2);line-height:1.85;">
셰이더 쪽 대응은 <code>Engine/Shaders/Private/SHCommon.ush</code>다. <code>FOneBandSHVector</code>(half 1개), <code>FTwoBandSHVector</code>(<code>half4</code>), <code>FThreeBandSHVector</code>(<code>half4 V0 + half4 V1 + half V2</code> = 9계수)가 정의되어 있고, <code>SHBasisFunction3</code>는 위 C++ 특수화와 같은 상수를 쓴다. 내적은 <code>DotSH3</code>다. <code>dot(V0,V0) + dot(V1,V1) + V2*V2</code>, 정확히 02장의 "적분 = 내적"이다. 셰이더의 <code>CalcDiffuseTransferSH3</code>는 한 발 더 나가 <code>max(0, cos θ)^Exponent</code>로 일반화되어 있는데, Exponent = 1을 넣으면 π, 2π/3, π/4로 돌아온다.
</p>

<p style="color:var(--text2);line-height:1.85;">
04장의 windowing도 이 파일에 있다. <code>ApplyWindowing</code>은 밴드별로 <code>1 / (1 + λ·l²(l+1)²)</code>을 곱해 고차 밴드를 눌러 내리고, <code>FindWindowingLambda</code>는 Newton 반복으로 목표 곡률(Laplacian)을 만족하는 λ를 찾는다. 코드 주석이 출처를 <em>"Stupid Spherical Harmonics (SH) Tricks"</em>라고 직접 밝혀 놓았다.
</p>

<div class="code-block"><div class="code-lang">C++ — SHMath.h ApplyWindowing (ringing 억제)</div><span class="kw">void</span> <span class="fn">ApplyWindowing</span>(<span class="kw">float</span> Lambda)
{
    <span class="cm">// "Stupid Spherical Harmonics (SH) Tricks" - Minimizing the weighted squared Laplacian</span>
    <span class="kw">for</span> (<span class="kw">int32</span> l = <span class="num">0</span>; l &lt; TSHVector::MaxSHOrder; l++)
    {
        <span class="kw">const float</span> BandScaleFactor = <span class="num">1.0f</span> / (<span class="num">1.0f</span> + Lambda * <span class="kw">float</span>(l*l * (l+<span class="num">1</span>)*(l+<span class="num">1</span>)));
        <span class="kw">for</span> (<span class="kw">int32</span> m = -l; m &lt;= l; m++)
            V[<span class="fn">SHGetBasisIndex</span>(l, m)] *= BandScaleFactor;
    }
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 함수는 실제 베이크 경로에서 호출된다. Lightmass가 Volumetric Lightmap 샘플을 구울 때 샘플마다 <code>FindWindowingLambda</code> → <code>ApplyWindowing</code>을 실행하고(<code>AdaptiveVolumetricLightmap.cpp</code>), 설정 구조체 주석에는 <em>"Volumetric Lightmap에 저장되는 조명의 곡률 상한. SH ringing을 windowing 필터로 줄이는 데 쓴다"</em>(<code>SceneExport.h</code>)라고 목적이 적혀 있다. 04장에서 말한 "굽는 단계에서 ringing을 미리 죽인다"가 이 경로다.
</p>

<span class="section-eyebrow">06 — UE: Volumetric Lightmap</span>

</div>

# Volumetric Lightmap: 9계수를 텍스처 7장에 접는 인코딩

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
언리얼에서 SH가 가장 대량으로 쓰이는 곳은 <strong>Volumetric Lightmap(VLM)</strong>이다. Lightmass가 공간을 브릭으로 덮고 셀마다 간접광을 3밴드 SH로 구워두면, 동적 오브젝트와 볼류메트릭 포그가 런타임에 이를 샘플링한다. 문제는 저장 포맷이다. 셀 하나가 RGB 9계수 = 27 float인데, float 27개를 그대로 두면 볼륨 텍스처가 감당이 안 된다. 엔진의 인코딩은 이렇다(<code>PrecomputedVolumetricLightmap.h</code>).
</p>

<div class="code-block"><div class="code-lang">C++ — PrecomputedVolumetricLightmap.h (브릭 데이터 레이어)</div><span class="kw">struct</span> <span class="ty">FVolumetricLightmapBasicBrickDataLayers</span>
{
    <span class="ty">FVolumetricLightmapDataLayer</span> AmbientVector;        <span class="cm">// DC(계수 0) RGB, float 텍스처</span>
    <span class="ty">FVolumetricLightmapDataLayer</span> SHCoefficients[<span class="num">6</span>];    <span class="cm">// 상위 8계수 × RGB = 24채널 → RGBA8 6장</span>
    <span class="ty">FVolumetricLightmapDataLayer</span> SkyBentNormal;
    <span class="ty">FVolumetricLightmapDataLayer</span> DirectionalLightShadowing;
};</div>

<p style="color:var(--text2);line-height:1.85;">
인코딩의 핵심은 계수를 둘로 나눈 것이다. <strong>DC(평균)만 HDR float으로 저장</strong>하고, 방향성을 담당하는 상위 8계수 × RGB = 24개 값은 <strong>DC 대비 상대값으로 정규화해 RGBA8(8비트) 텍스처 6장</strong>에 밀어 넣는다(8비트 × 4채널 × 6장 = 24채널). 밝기의 다이내믹 레인지는 DC가 전부 감당하고, 방향성 계수는 "DC 대비 비율"이라 8비트로 충분하기 때문이다. 셰이더는 읽을 때 <code>*2−1</code>로 부호를 복원하고 <code>SHDenormalizationScales</code>(<code>0.488603/0.282095</code> 같은 basis 상수 비율)를 곱한 뒤 AmbientVector를 곱해 원래 계수로 되돌린다(<code>VolumetricLightmapShared.ush</code>).
</p>

<p style="color:var(--text2);line-height:1.85;">
읽는 쪽은 품질을 세 단계로 나눠 놓았다. <code>VolumetricLightmapShared.ush</code>는 <code>GetVolumetricLightmapSH1 / SH2 / SH3</code>를 제공하고, <code>BasePassPixelShader.usf</code>가 머티리얼 종류에 따라 골라 쓴다.
</p>

<div class="data-table">
<table>
<tr><th>경로</th><th>사용 함수</th><th>계수</th><th>코드 주석</th></tr>
<tr><td>불투명 기본 경로</td><td><code>GetVolumetricLightmapSH3</code></td><td>9</td><td>—</td></tr>
<tr><td>반투명 (volumetric directional)</td><td><code>GetVolumetricLightmapSH2</code></td><td>4</td><td><em>"Limit Volume Directional to SH2 for performance"</em></td></tr>
<tr><td>반투명 (non-directional)</td><td><code>GetVolumetricLightmapSH1</code></td><td>1</td><td>DC만 (방향성 포기)</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
같은 데이터라도 <strong>픽셀 비용이 비싼 곳에서는 밴드를 낮춰 읽는다</strong>. 이 패턴은 이후 모든 사용처에서 반복된다. 저장은 품질 기준(3밴드), 소비는 예산 기준(1~3밴드)이라는 이원화다.
</p>

<span class="section-eyebrow">07 — UE: Sky Light</span>

</div>

# 스카이라이트: 큐브맵 하나가 float4 7개로 줄어드는 경로

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
스카이라이트는 SH의 교과서적 사용처다. 하늘 큐브맵이 만드는 diffuse 조명은 "법선 <b>n</b>인 표면이 받는 irradiance"라는 구면 함수이고, 03장에서 봤듯 이 함수는 9계수면 충분하다. 경로는 세 단계다. ① 캡처된 큐브맵을 GPU 패스가 <code>FSHVectorRGB3</code>(27계수)로 프로젝션한다(<code>ReflectionEnvironmentDiffuseIrradiance.cpp</code>의 <code>ComputeDiffuseIrradiance</code>). ② CPU가 이 계수를 셰이더용 상수 <strong>float4 7개</strong>로 패킹한다. ③ 픽셀 셰이더가 법선 하나로 그것을 평가한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
②의 패킹 함수(<code>ReflectionEnvironment.cpp</code>의 <code>SetupSkyIrradianceEnvironmentMapConstants...</code>)에 붙은 주석이 설계 의도를 요약한다. <em>"조명 적용에 셰이더 명령이 최소가 되도록 SH 계수를 패킹한다. diffuse convolution 계수가 미리 구워져 있다. 'Stupid Spherical Harmonics (SH) Tricks' 참조"</em>라는 내용이다. 즉 π·2π/3·π/4 곱(05장의 <code>CalcDiffuseTransfer</code>)과 basis 상수까지 전부 <strong>패킹 시점에 미리 곱해두고</strong>, 셰이더에는 곱셈-덧셈만 남긴다. ③이 그 결과인 <code>GetSkySHDiffuse</code>다. 03장 callout에서 말한 "법선의 2차 형식" 그대로다.
</p>

<div class="code-block"><div class="code-lang">HLSL — ReflectionEnvironmentShared.ush GetSkySHDiffuse</div><span class="cm">// SH basis 평가와 diffuse convolution 가중치가 결합되어 ALU 최소화 ("Stupid SH Tricks")</span>
<span class="kw">float3</span> <span class="fn">GetSkySHDiffuse</span>(<span class="kw">float3</span> Normal)
{
    <span class="kw">float4</span> NormalVector = <span class="fn">float4</span>(Normal, <span class="num">1.0f</span>);

&#x20;   Intermediate0.x = <span class="fn">dot</span>(SkyIrradianceEnvironmentMap[<span class="num">0</span>], NormalVector);   <span class="cm">// band 0+1 (R)</span>
    Intermediate0.y = <span class="fn">dot</span>(SkyIrradianceEnvironmentMap[<span class="num">1</span>], NormalVector);   <span class="cm">// band 0+1 (G)</span>
    Intermediate0.z = <span class="fn">dot</span>(SkyIrradianceEnvironmentMap[<span class="num">2</span>], NormalVector);   <span class="cm">// band 0+1 (B)</span>

    <span class="kw">float4</span> vB = NormalVector.xyzz * NormalVector.yzzx;                     <span class="cm">// xy, yz, z², xz</span>
    ...                                                                    <span class="cm">// band 2 앞 4개</span>
    <span class="kw">float</span> vC = NormalVector.x * NormalVector.x - NormalVector.y * NormalVector.y;
    Intermediate2 = SkyIrradianceEnvironmentMap[<span class="num">6</span>].xyz * vC;               <span class="cm">// band 2 마지막 (x²−y²)</span>

    <span class="cm">// max to not get negative colors  ← ringing 대책 (04장)</span>
    <span class="kw">return</span> <span class="fn">max</span>(<span class="num">0</span>, Intermediate0 + Intermediate1 + Intermediate2);

}</div>

<p style="color:var(--text2);line-height:1.85;">
하늘 전체의 diffuse 조명이 <strong>dot 몇 개와 max 하나</strong>로 끝난다. 마지막 <code>max(0, …)</code>에 주목하자. 주석 그대로 "음수 색을 막기 위한" 클램프인데, 이것이 04장에서 본 <strong>negative lobe의 실전 방어선</strong>이다. 밝은 태양이 박힌 하늘을 9계수로 자르면 반대편에 음수 링잉이 생길 수 있고, 엔진은 이를 평가 마지막에 잘라낸다. 같은 파일에는 <code>GetSkySHDiffuseSimple</code>도 있다. <em>"Only does the first 3 components for speed"</em>라는 주석대로 선형 항까지만 평가하는 저비용 버전으로, 모바일 기본 경로와 Volumetric Fog 폴백이 이걸 쓴다. 06장과 같은 패턴이다. 데이터는 9계수로 저장하고, 소비는 예산에 맞춘다.
</p>

<span class="section-eyebrow">08 — UE: Lumen · ILC · Lightmass</span>

</div>

# Lumen도 굽고, ILC도 굽는다: 실시간과 오프라인의 같은 선택

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
SH를 "오프라인에 굽는 포맷"으로만 생각하기 쉬운데, <strong>Lumen은 매 프레임 실시간으로 SH를 굽는다.</strong> Screen Probe Gather는 화면에 깐 프로브마다 반구로 광선을 쏘아 radiance를 모으는데, 필터링 패스(<code>LumenScreenProbeFiltering.usf</code>)가 그 radiance를 <code>SHBasisFunction3</code> + <code>MulSH3</code>로 <strong>3밴드 SH에 프로젝션</strong>한다. 저장 방식은 VLM과 판박이다. DC는 <code>ScreenProbeRadianceSHAmbient</code>(float RGB)에 넣고, 상위 8계수는 DC 대비 정규화·양자화(<code>SH_QUANTIZE_DIRECTIONAL_COEFFICIENTS</code>)해서 <code>ScreenProbeRadianceSHDirectional</code>에 넣으며, 읽을 때 <code>SHDenormalizationScales</code>로 복원한다(<code>LumenScreenProbeGather.usf</code>의 <code>GetScreenProbeSH</code>). 오프라인에서 검증된 인코딩을 실시간 GI가 그대로 재사용하는 것이다. 참고로 Lumen의 Radiance Cache는 SH가 아니라 octahedral 텍스처 프로브를 쓴다. 그쪽은 <a href="/ddgi">DDGI 글</a>에서 다룬 계열이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
레거시 쪽도 보자. <strong>Indirect Lighting Cache(ILC)</strong>는 VLM 이전 세대의 동적 오브젝트 간접광 캐시인데, 여기 주석 두 줄이 밴드 선택의 논리를 그대로 보여준다(<code>IndirectLightingCache.cpp</code>). 오브젝트 단위 point 샘플은 <code>FSHVectorRGB3</code>를 쓰면서 <em>"항상 point 보간을 해서 유효한 3밴드 샘플을 얻는다"</em>고 하고, 볼륨 텍스처 쪽은 <code>FSHVectorRGB2</code>를 쓰면서 <em>"볼륨 텍스처는 2밴드로 인코딩되어 있으니 3밴드를 보간하느라 성능을 낭비할 이유가 없다"</em>고 적혀 있다. 같은 파일의 <code>ReduceSHRinging</code>은 이름 그대로 링잉 억제 함수다. 광원 반대편 조명이 5% 밑으로 떨어지지 않게 계수를 조정한다. 04장의 negative lobe 문제를 스카이라이트는 <code>max(0,…)</code>로, ILC는 계수 보정으로, VLM은 windowing으로 막는다. <strong>세 곳이 세 가지 방식으로 같은 문제를 막고 있는 것이다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
데이터의 생산자인 <strong>Lightmass</strong>는 볼륨 샘플을 <code>#define LM_NUM_SH_COEFFICIENTS 9</code>로 못 박아 두고(<code>ImportExport.h</code>), gathering 결과를 <code>FSHVectorRGB3</code>로 변환해 내보낸다(<code>SampleVolume.cpp</code>). 서피스 라이트맵과 비교하면 구분이 뚜렷해진다. 표면은 법선이 노멀맵 범위로 제한되어 전체 구면 함수가 필요 없고, 그래서 SH가 아니라 <strong>2계수 directional 인코딩</strong>(<code>LM_NUM_HQ_LIGHTMAP_COEF = 2</code>)을 쓴다. "구면 전체가 필요한 볼륨 데이터에만 SH를 쓴다"는 구분이 명확하다.
</p>

<span class="section-eyebrow">09 — UE: 밴드 선택의 규칙</span>

</div>

# 엔진 전체를 관통하는 규칙: 품질 경로는 9개, 성능 경로는 4개

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
나머지 사용처까지 한꺼번에 펼치면 엔진의 일관된 규칙이 드러난다. <strong>반투명 라이팅 볼륨</strong>은 ambient 텍스처(DC) + directional 텍스처(선형 3계수)의 3D 텍스처 쌍, 즉 2밴드를 쪼개 저장한 구조다(<code>TranslucencyVolumeCommon.ush</code>의 <code>ReconstructSHCoefficients</code>가 <code>FTwoBandSHVectorRGB</code>로 재조립한다). MegaLights도 반투명 조명은 이 볼륨에 주입하므로 같은 2밴드다. <strong>Volumetric Fog</strong>는 VLM을 <code>GetVolumetricLightmapSH2</code>(2밴드)로 읽고, Henyey-Greenstein 위상 함수를 zonal harmonic으로 표현해 <code>DotSH</code> 한 번으로 산란을 적분한다. 02장의 성질 ①과 ③이 동시에 쓰이는 지점이다. 반대로 <strong>Hair 환경광</strong>은 <code>#define INTEGRATION_SH 3</code>로 3밴드를 고수한다. 머리카락이 조명 방향성에 민감하기 때문이다.
</p>

<div class="data-table">
<table>
<tr><th>사용처</th><th>밴드</th><th>계수/채널</th><th>선택 이유 (코드 주석)</th></tr>
<tr><td>Volumetric Lightmap 저장</td><td><span class="flag-badge flag-blue">3밴드</span></td><td>9</td><td>품질 기준 (굽는 단계에서 windowing 적용)</td></tr>
<tr><td>VLM 소비 (불투명)</td><td><span class="flag-badge flag-blue">3밴드</span></td><td>9</td><td>기본 경로</td></tr>
<tr><td>VLM 소비 (반투명)</td><td><span class="flag-badge flag-gold">2밴드</span></td><td>4</td><td><em>"Limit ... to SH2 for performance"</em></td></tr>
<tr><td>Sky irradiance 저장</td><td><span class="flag-badge flag-blue">3밴드</span></td><td>9 (7×float4)</td><td>convolution 미리 구움</td></tr>
<tr><td>Sky 소비 (모바일)</td><td><span class="flag-badge flag-gold">부분 (선형)</span></td><td>—</td><td><em>"first 3 components for speed"</em></td></tr>
<tr><td>Lumen Screen Probe</td><td><span class="flag-badge flag-blue">3밴드</span></td><td>9</td><td>매 프레임 실시간 프로젝션</td></tr>
<tr><td>ILC point 샘플</td><td><span class="flag-badge flag-blue">3밴드</span></td><td>9</td><td><em>"valid 3band single sample"</em></td></tr>
<tr><td>ILC 볼륨 텍스처</td><td><span class="flag-badge flag-gold">2밴드</span></td><td>4</td><td><em>"no reason to waste perf interpolating 3 bands"</em></td></tr>
<tr><td>Lightmass 볼륨 샘플</td><td><span class="flag-badge flag-blue">3밴드</span></td><td>9</td><td><code>LM_NUM_SH_COEFFICIENTS 9</code></td></tr>
<tr><td>반투명 라이팅 볼륨</td><td><span class="flag-badge flag-gold">2밴드</span></td><td>4</td><td>ambient + directional 텍스처 분리</td></tr>
<tr><td>Volumetric Fog</td><td><span class="flag-badge flag-gold">2밴드</span></td><td>4</td><td>+ HG 위상을 zonal harmonic으로</td></tr>
<tr><td>Hair 환경광</td><td><span class="flag-badge flag-blue">3밴드</span></td><td>9</td><td><code>INTEGRATION_SH 3</code></td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
표를 세로로 읽으면 규칙이 하나로 정리된다. <strong>저장·품질 경로(굽기, 스카이, 불투명 셰이딩, 헤어)는 3밴드 9계수, 픽셀 수가 폭발하는 성능 경로(볼륨 텍스처, 반투명, 포그, 모바일)는 2밴드 4계수 이하다.</strong> 그리고 그 위는 어디에도 없다. 03·04장의 이론이 예측한 그대로, 4밴드 이상을 쓰는 렌더링 경로는 엔진에 존재하지 않는다.
</p>

<span class="section-eyebrow">10 — 업계 비교</span>

</div>

# 다른 엔진들의 선택: 9개 아래로 내려간 이유들

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
언리얼 밖으로 눈을 돌리면 엔진마다 선택이 갈린다. 다만 갈린 지점은 "9개보다 많이 쓰느냐"가 아니라 <strong>"9개냐, 그보다 적게냐"</strong>다. 위로 올려봐야 얻을 게 없다는 04장의 결론은 모두가 공유했고, 아래로 얼마나 깎을 수 있느냐만 다퉜다.
</p>

<div class="data-table">
<table>
<tr><th>엔진 / 게임</th><th>선택</th><th>계수 (RGB)</th><th>근거</th></tr>
<tr><td>Unity (Light Probe)</td><td>L2</td><td>27 float</td><td>공식 문서: "third order polynomials, L2 spherical harmonics ... 27 floating point values" + Remove Ringing 옵션</td></tr>
<tr><td>Halo 3 (2007)</td><td>L2 라이트맵</td><td>텍셀당 9텍스처</td><td>"Each texel is a SH Vector. 9 textures for quadratic SH". DXT 압축 + Luvw 색공간으로 HDR·음수 계수 처리</td></tr>
<tr><td>Far Cry 3 (2012)</td><td>L1</td><td>4 float × transfer basis</td><td>프로브 전체 시스템 메모리 1MB 미만, GPU 0.5ms 미만이라는 메모리·성능 제약</td></tr>
<tr><td>Frostbite (2018)</td><td>L1 라이트맵</td><td>텍셀당 12계수</td><td>SG·RNM·H-basis·ambient cube 전부 평가 후 "저장·평가·품질의 최적 절충"으로 L1 선택. 탄젠트 프레임 불필요가 장점</td></tr>
<tr><td>Half-Life 2 (2004)</td><td>SH 아님</td><td>3방향 basis / ambient cube 6색</td><td>SH 대중화 이전의 대안. 라이트맵 3배 메모리, 동적 오브젝트는 6방향 상자</td></tr>
<tr><td>Activision ZH3 (2024)</td><td>L1 + zonal 1개</td><td>15계수</td><td>"L1은 irradiance를 정확히 못 담고 음수 복원 문제가 있다". L1(12)과 L2(27) 사이의 현대적 절충</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
L1로 내려간 진영(Far Cry 3, Frostbite)의 동기는 한결같이 메모리다. 라이트맵 텍셀마다 SH를 넣으면 27계수는 감당이 안 된다. 대신 품질 문제를 안는다. 03장의 표가 보여주듯 L1은 커널 에너지의 87.5%만 담고, 선형 복원은 음수가 나오기 쉽다(Geomerics가 비선형 복원 모델을 만든 이유다). 2024년 Activision의 <strong>ZH3</strong>가 이 절충의 최신 답이다. L1에 <strong>quadratic zonal 계수를 채널당 1개(RGB 3개)</strong>만 더한 15계수로 L2 품질에 다가선다. 밴드 2를 통째로 넣는 대신 "가장 중요한 축 방향의 2차 성분" 하나만 넣는 발상이다. 02장에서 본 zonal harmonics가 20년이 지난 지금도 연구 재료로 쓰이는 셈이다.
</p>

<span class="section-eyebrow">정리</span>

</div>

# 정리

<div class="sh-post">
<p style="color:var(--text2);line-height:1.85;">
한 문장으로 압축하면 이렇다. <strong>SH는 구면 위의 푸리에 급수이고, diffuse 조명(irradiance)은 clamped cosine 커널이 밴드 2 위를 지워버리는 저주파 함수라서 9계수(RGB 27개)로 99%가 담긴다. 그 위로는 ringing·negative lobe·제곱 비용만 남기 때문에, 언리얼을 포함한 엔진들은 L2를 상한으로 두고 성능 경로에서는 오히려 아래로(2밴드·4계수) 깎아 쓴다.</strong>
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">π · 2π/3 · π/4 · 0</div>
<div class="card-title">9라는 숫자의 출처</div>
<div class="card-desc">clamped cosine의 SH 계수. 밴드 3에서 정확히 0, 이후 l<sup>−5/2</sup>로 급감. 조명이 아무리 고주파여도 irradiance엔 밴드 2 위가 거의 없다.</div>
</div>
<div class="card teal">
<div class="card-label">99.22%</div>
<div class="card-title">수확 체감의 수치</div>
<div class="card-desc">L1 = 87.5%, L2 = 99.22%, L4 = 99.81%. L2→L4는 계수 2.8배에 +0.6%p다. 9계수가 diffuse 근사의 수확 체감 지점이다.</div>
</div>
<div class="card coral">
<div class="card-label">ringing</div>
<div class="card-title">고차의 대가</div>
<div class="card-desc">Gibbs 물결, HDR 광원의 negative lobe, n² 비용. 엔진은 windowing(Lightmass) · max(0,…)(스카이) · 계수 보정(ILC) 삼중으로 방어한다.</div>
</div>
<div class="card gold">
<div class="card-label">3밴드 vs 2밴드</div>
<div class="card-title">언리얼의 일관된 규칙</div>
<div class="card-desc">저장·품질 경로(VLM·스카이·Lumen 프로브·헤어)는 9계수, 성능 경로(반투명·포그·모바일·ILC 볼륨)는 4계수. 4밴드 이상은 엔진에 없다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
숫자로 다시 새겨 두자. basis 상수 0.282095 · 0.488603 · 1.092548, 컨볼루션 상수 π · 2π/3 · π/4 · 0 · −π/24, 커널 에너지 87.5 → 99.22 → 99.81%, 계수 4 → 9 → 16 → 25(n²), VLM 인코딩은 float DC 1장 + RGBA8 6장, 스카이 패킹은 float4 7개. GI 기법의 계보에서 보면 SH는 "구면 함수를 어디에나 끼워 넣을 수 있게 만든 압축 포맷"이다. Lightmass가 굽는 것도, Lumen이 매 프레임 만드는 것도, <a href="/ddgi">DDGI</a>의 octahedral 프로브가 대체하려는 것도 결국 같은 구면 함수 저장 문제의 답들이다. 그리고 2024년의 ZH3까지, "몇 개의 숫자로 구면을 접을 것인가"라는 질문은 여전히 현역이다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card blue">
<div class="card-label">원 논문 (2001)</div>
<div class="card-title">An Efficient Representation for Irradiance Environment Maps</div>
<div class="card-desc"><a href="https://cseweb.ucsd.edu/~ravir/papers/envmap/envmap.pdf">cseweb.ucsd.edu — envmap.pdf</a> — Ramamoorthi &amp; Hanrahan, SIGGRAPH 2001. 9계수·오차 3%/9%/1%의 출처. 자매편 <a href="https://graphics.stanford.edu/papers/invlamb/invlamb.pdf">JOSA A 2001(invlamb)</a>이 l<sup>−5/2</sup> 감쇠와 "order 2까지만 측정 가능"의 출처.</div>
</div>
<div class="card purple">
<div class="card-label">실무 바이블 (2008)</div>
<div class="card-title">Stupid Spherical Harmonics (SH) Tricks</div>
<div class="card-desc"><a href="https://www.ppsloan.org/publications/StupidSH36.pdf">ppsloan.org/publications/StupidSH36.pdf</a> — Peter-Pike Sloan, GDC 2008. windowing·ringing·negative lobe·패킹 트릭. 언리얼 소스 주석이 두 곳에서 직접 인용하는 문서.</div>
</div>
<div class="card teal">
<div class="card-label">엔진 소스</div>
<div class="card-title">언리얼엔진 5.8</div>
<div class="card-desc"><code>SHMath.h</code>, <code>SHCommon.ush</code>, <code>PrecomputedVolumetricLightmap.h/.cpp</code>, <code>VolumetricLightmapShared.ush</code>, <code>ReflectionEnvironment.cpp</code>, <code>ReflectionEnvironmentShared.ush</code>, <code>LumenScreenProbeFiltering.usf</code>, <code>IndirectLightingCache.cpp</code>, Lightmass <code>ImportExport.h</code> · <code>SampleVolume.cpp</code>. 이 글의 모든 엔진 코드 인용의 1차 출처.</div>
</div>
<div class="card gold">
<div class="card-label">보강 자료</div>
<div class="card-title">에너지 분석 · 업계 발표 · ZH3</div>
<div class="card-desc">Basri &amp; Jacobs, "Lambertian Reflectance and Linear Subspaces" (TPAMI 2003, 87.5/99.22/99.81%); Chen &amp; Liu, "Lighting and Material of Halo 3" (2008); Gilabert &amp; Stefanov, "Deferred Radiance Transfer Volumes" (GDC 2012); O'Donnell, "Precomputed GI in Frostbite" (GDC 2018); Roughton et al., "ZH3: Quadratic Zonal Harmonics" (I3D 2024).</div>
</div>
</div>
</div>
