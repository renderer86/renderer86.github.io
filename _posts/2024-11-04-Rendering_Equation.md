---
layout: post
title: "렌더링 방정식, 직관부터: 언리얼 엔진5는 빛을 어떻게 계산하나"
icon: paper
permalink: d8c73243c492ed7b5f44b70936cfe4521669ad34
categories: Rendering
tags: [Rendering, UnrealEngine]
excerpt: "Rendering Equation"
back_color: "#ffffff"
img_name: "rendering_equation.webp"
toc: false
show: true
new: true
series: -1
---

**이런 분이 읽으면 좋습니다!**

- 언리얼 엔진5를 사용하면서 빛이 어떻게 계산되는지 궁금했던 분
- 그래픽스 전공이 아니어도 PBR·Lumen·Nanite의 큰 그림을 직관적으로 잡고 싶은 분
- 렌더링 코드를 읽고 쓸 때 "지금 방정식의 어느 항을 만지고 있는지" 아는 지도가 필요한 프로그래머

**이 글로 알 수 있는 내용**

- 화면 한 픽셀의 색이 정해지는 과정을 일상적인 비유로 이해하기
- 카지야 렌더링 방정식의 각 항이 무엇을 의미하는지
- 실시간 렌더링이 방정식을 공략하는 네 가지 전략 — 분해·급수 절단·Monte Carlo·사전계산
- UE5의 Nanite, Lumen, VSM이 방정식의 어느 부분을 담당하는지
- 직접광이 적분 없이 GPU에서 계산되는 이유와, Lumen이 간접광을 어떤 기법들로 나누어 근사하는지
- 방정식의 각 항이 UE 5.7.4 셰이더 소스의 실제 코드 몇 줄에 대응하는지 (BRDF.ush · ShadingModels.ush · DeferredLightingCommon.ush …)

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style> .re-post { --bg2: #f4f6fb; --bg3: #eef0f7; --surface: #f9fafd; --surface2: #eceef7; --border: rgba(60,80,180,0.10); --border2: rgba(60,80,180,0.22); --text: #1a1d2e; --text2: #464c6a; --text3: #8890aa; --accent: #3d63e0; --accent2: #7248d4; --gold: #b07d00; --teal: #0a8f62; --coral: #d63031; --orange: #c85a00; } .re-post .eq-block { position: relative; background: var(--bg2); border: 1px solid var(--border2); border-radius: 16px; padding: 32px 40px; margin: 24px 0 40px; overflow-x: auto; overflow-y: hidden; font-family: 'JetBrains Mono', monospace; } .re-post .eq-block::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent); } .re-post .eq-label { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--text3); margin-bottom: 16px; } .re-post .eq-main { font-size: clamp(13px, 2.5vw, 16px); color: var(--text); line-height: 2.2; white-space: nowrap; word-break: normal; min-width: max-content; } .re-post .eq-term { color: var(--accent); font-weight: 600; } .re-post .eq-op { color: var(--text3); } .re-post .eq-fn { color: var(--teal); font-weight: 600; } .re-post .eq-int { color: var(--gold); font-size: 1.3em; } .re-post .section-eyebrow { display: block; font-size: 18px; font-weight: 700; letter-spacing: 0.06em; text-transform: none; color: var(--accent); margin-bottom: 4px; margin-top: 56px; } .re-post .term-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin: 28px 0; } .re-post .term-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; position: relative; overflow: hidden; transition: border-color 0.2s, box-shadow 0.2s; } .re-post .term-card:hover { border-color: var(--border2); box-shadow: 0 2px 12px rgba(60,80,180,0.07); } .re-post .term-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; } .re-post .term-card.blue::before { background: var(--accent); } .re-post .term-card.gold::before { background: var(--gold); } .re-post .term-card.teal::before { background: var(--teal); } .re-post .term-card.coral::before { background: var(--coral); } .re-post .term-card.purple::before { background: var(--accent2); } .re-post .term-card.orange::before { background: var(--orange); } .re-post .term-symbol { font-family: 'JetBrains Mono', monospace; font-size: 17px; font-weight: 600; margin-bottom: 6px; } .re-post .term-card.blue .term-symbol { color: var(--accent); } .re-post .term-card.gold .term-symbol { color: var(--gold); } .re-post .term-card.teal .term-symbol { color: var(--teal); } .re-post .term-card.coral .term-symbol { color: var(--coral); } .re-post .term-card.purple .term-symbol { color: var(--accent2); } .re-post .term-card.orange .term-symbol { color: var(--orange); } .re-post .term-name { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 4px; } .re-post .term-desc { font-size: 13px; color: var(--text2); line-height: 1.65; margin: 0; } .re-post .pipeline { display: flex; flex-direction: column; margin: 28px 0; position: relative; } .re-post .pipeline::before { content: ''; position: absolute; left: 27px; top: 54px; bottom: 54px; width: 1px; background: linear-gradient(to bottom, var(--accent), var(--accent2)); opacity: 0.25; } .re-post .pipe-item { display: grid; grid-template-columns: 54px 1fr; gap: 18px; padding: 20px 0; position: relative; } .re-post .pipe-num { width: 54px; height: 54px; border-radius: 50%; border: 1px solid var(--border2); background: var(--surface); display: flex; align-items: center; justify-content: center; font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600; color: var(--accent); flex-shrink: 0; position: relative; z-index: 1; } .re-post .pipe-body h3 { font-size: 1rem; font-weight: 700; color: var(--text); margin-bottom: 6px; } .re-post .pipe-body p { font-size: 14px; color: var(--text2); line-height: 1.75; margin: 0; } .re-post .pipe-body p + p { margin-top: 10px; } .re-post .pipe-tag-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; } .re-post .pipe-tag { font-size: 11px; padding: 3px 10px; border-radius: 100px; font-weight: 600; letter-spacing: 0.04em; } .re-post .tag-geo { background: rgba(61,99,224,0.10); color: var(--accent); } .re-post .tag-light { background: rgba(176,125,0,0.10); color: var(--gold); } .re-post .tag-gi { background: rgba(10,143,98,0.10); color: var(--teal); } .re-post .tag-shadow { background: rgba(114,72,212,0.10); color: var(--accent2); } .re-post .tag-post { background: rgba(200,90,0,0.10); color: var(--orange); } .re-post .step-badge { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; margin-bottom: 4px; } .re-post .badge-approx { background: rgba(200,90,0,0.12); color: var(--orange); } .re-post .badge-exact { background: rgba(10,143,98,0.12); color: var(--teal); } .re-post .badge-hybrid { background: rgba(61,99,224,0.12); color: var(--accent); } .re-post .mapping-table { width: 100%; border-collapse: collapse; margin: 28px 0; font-size: 14px; } .re-post .mapping-table th { background: var(--surface2); padding: 10px 14px; text-align: left; font-weight: 700; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text3); border: 1px solid var(--border); } .re-post .mapping-table td { padding: 12px 14px; border: 1px solid var(--border); vertical-align: top; line-height: 1.6; } .re-post .mapping-table tr { background: #ffffff; } .re-post .mapping-table tr:nth-child(odd) { background: var(--surface); } .re-post .mapping-table tr:hover { background: var(--surface2); } .re-post .math-cell { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--accent); font-weight: 600; } .re-post .ue5-cell { color: var(--teal); font-weight: 600; } .re-post .desc-cell { color: var(--text2); } .re-post .callout { border-radius: 12px; padding: 18px 22px; margin: 24px 0; border: 1px solid; position: relative; overflow: hidden; } .re-post .callout::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; } .re-post .callout-info { background: rgba(61,99,224,0.05); border-color: rgba(61,99,224,0.18); } .re-post .callout-info::before { background: var(--accent); } .re-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); } .re-post .callout-warn::before { background: var(--gold); } .re-post .callout-title { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6px; } .re-post .callout-info .callout-title { color: var(--accent); } .re-post .callout-warn .callout-title { color: var(--gold); } .re-post .callout p { margin: 0; font-size: 14px; color: var(--text2); line-height: 1.75; } .re-post .code-block { background: #1e2230; border: 1px solid rgba(120,140,200,0.15); border-radius: 12px; padding: 22px; font-family: 'JetBrains Mono', monospace; font-size: 13px; line-height: 1.8; overflow-x: auto; margin: 20px 0; position: relative; white-space: pre; color: #c8d0ea; } .re-post .code-block .kw { color: #a78bfa; } .re-post .code-block .fn { color: #34d399; } .re-post .code-block .cm { color: #525a78; font-style: italic; } .re-post .code-block .num { color: #fb923c; } .re-post .code-lang { position: absolute; top: 10px; right: 14px; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #525a78; } .re-post .brdf-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 24px 0; } @media (max-width: 640px) { .re-post .brdf-grid { grid-template-columns: 1fr; } .re-post .term-grid { grid-template-columns: 1fr; } } .re-post .brdf-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; text-align: center; } .re-post .brdf-card .icon { font-size: 26px; margin-bottom: 8px; display: block; } .re-post .brdf-card h4 { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 4px; } .re-post .brdf-card p { font-size: 12px; color: var(--text2); margin: 0; line-height: 1.55; } .re-post .summary-box { background: linear-gradient(135deg, rgba(61,99,224,0.06) 0%, rgba(114,72,212,0.06) 100%); border: 1px solid rgba(61,99,224,0.18); border-radius: 16px; padding: 36px; margin: 32px 0; text-align: center; } .re-post .summary-box h3 { font-size: 1.25rem; font-weight: 700; margin-bottom: 12px; color: var(--text); } .re-post .summary-box p { width: 100%; max-width: none; margin: 0; font-size: 15px; line-height: 1.85; color: var(--text2); text-align: left; } .re-post .intuition { background: linear-gradient(135deg, rgba(61,99,224,0.05), rgba(10,143,98,0.05)); border: 1px solid var(--border2); border-radius: 16px; padding: 26px 30px; margin: 24px 0; } .re-post .intuition p { font-size: 15px; line-height: 1.9; color: var(--text); margin: 0 0 14px; } .re-post .intuition p:last-child { margin-bottom: 0; } .re-post .scene-fig { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px 20px; margin: 26px 0; } .re-post .scene-fig svg { width: 100%; height: auto; display: block; } .re-post .scene-cap { font-size: 12px; color: var(--text3); text-align: center; margin-top: 14px; line-height: 1.65; } .re-post .eq-read { display: flex; flex-direction: column; gap: 10px; margin: 24px 0; } .re-post .eq-read-row { display: grid; grid-template-columns: 190px 1fr; gap: 16px; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 13px 18px; } .re-post .eq-read-sym { font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 600; color: var(--accent); } .re-post .eq-read-txt { font-size: 13.5px; color: var(--text2); line-height: 1.7; } .re-post .eq-read-txt strong { color: var(--text); } @media (max-width: 640px) { .re-post .eq-read-row { grid-template-columns: 1fr; gap: 5px; } } .re-post .analogy { display: flex; gap: 13px; align-items: flex-start; background: var(--surface); border-radius: 10px; padding: 13px 16px; margin: 12px 0 0; border-left: 3px solid var(--teal); } .re-post .analogy .a-icon { font-size: 19px; line-height: 1.4; flex-shrink: 0; } .re-post .analogy .a-text { font-size: 12.5px; color: var(--text2); line-height: 1.65; } .re-post .analogy .a-text strong { color: var(--text); } .re-post .editor-link { display: inline-block; margin-top: 8px; font-size: 11px; color: var(--accent); background: rgba(61,99,224,0.08); padding: 3px 9px; border-radius: 6px; font-weight: 600; } .re-post .deep-dive { border: 1px solid var(--border2); border-radius: 12px; margin: 18px 0; background: var(--surface); overflow: hidden; } .re-post .deep-dive > summary { cursor: pointer; padding: 14px 18px; font-size: 13px; font-weight: 700; color: var(--accent2); list-style: none; display: flex; align-items: center; gap: 9px; user-select: none; } .re-post .deep-dive > summary::-webkit-details-marker { display: none; } .re-post .deep-dive > summary::before { content: '▶'; font-size: 9px; color: var(--text3); transition: transform 0.2s; } .re-post .deep-dive[open] > summary::before { transform: rotate(90deg); } .re-post .deep-dive > summary:hover { background: var(--surface2); } .re-post .deep-dive .dd-body { padding: 2px 20px 18px; } .re-post .deep-dive .dd-body p { font-size: 13px; color: var(--text2); line-height: 1.78; margin: 0 0 11px; } .re-post .deep-dive .dd-body p:last-child { margin-bottom: 0; } .re-post .deep-dive .dd-body strong { color: var(--text); } </style>

<div class="re-post">
<span class="section-eyebrow" style="margin-top:0;">00 — 직관부터</span>
</div>

# 빛이 눈에 들어오기까지

<div class="re-post">
<div class="intuition">
<p>책상 위 머그컵을 본다고 하자. 우리가 그 컵을 "본다"는 것은, 컵 표면의 한 점에서 출발한 빛이 눈(또는 카메라)으로 들어왔다는 뜻이다. 그렇다면 그 점은 어디서 빛을 받았을까? 천장 조명에서 곧장 받기도 하고, 옆에 놓인 빨간 노트에 한 번 튕긴 빛을 받기도 한다. 그래서 컵의 그늘진 부분이 살짝 붉게 물든다.</p>
<p>결국 화면의 한 픽셀 색을 정하는 일은 이 질문 하나로 요약된다 — <strong>"이 점으로 사방에서 들어온 모든 빛을, 이 표면의 재질이 카메라 방향으로 얼마나 되돌려 보내는가?"</strong> 카지야의 렌더링 방정식은 바로 이 문장을 수식 한 줄로 옮긴 것이다. 기호가 어려워 보일 뿐, 말하는 내용은 위 한 문장이 전부다.</p>
</div>
<div class="scene-fig">
<svg viewBox="0 0 620 250" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono', monospace">
<defs>
<marker id="ah-gold" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#b07d00"/></marker>
<marker id="ah-teal" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0a8f62"/></marker>
<marker id="ah-blue" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#3d63e0"/></marker>
</defs>
<path d="M 230 188 A 80 80 0 0 1 390 188" fill="rgba(61,99,224,0.04)" stroke="rgba(61,99,224,0.28)" stroke-width="1" stroke-dasharray="4 4"/>
<text x="310" y="98" fill="#8890aa" font-size="12" text-anchor="middle">반구 Ω — 사방에서 빛이 들어온다</text>
<line x1="175" y1="188" x2="445" y2="188" stroke="#464c6a" stroke-width="2"/>
<line x1="310" y1="188" x2="310" y2="122" stroke="#8890aa" stroke-width="1.2" stroke-dasharray="3 3"/>
<text x="318" y="130" fill="#8890aa" font-size="12">N (법선)</text>
<circle cx="310" cy="188" r="4.5" fill="#1a1d2e"/>
<text x="302" y="208" fill="#1a1d2e" font-size="13" font-weight="600">x</text>
<circle cx="95" cy="45" r="20" fill="#f3c64a"/>
<text x="95" y="82" fill="#b07d00" font-size="12" text-anchor="middle">조명 (직접광)</text>
<line x1="110" y1="58" x2="303" y2="182" stroke="#b07d00" stroke-width="2" marker-end="url(#ah-gold)"/>
<text x="150" y="118" fill="#b07d00" font-size="11">직접광 L<tspan baseline-shift="sub" font-size="8">i</tspan></text>
<rect x="52" y="150" width="20" height="60" rx="3" fill="rgba(214,48,49,0.5)"/>
<text x="62" y="228" fill="#d63031" font-size="11" text-anchor="middle">붉은 벽</text>
<line x1="82" y1="62" x2="68" y2="150" stroke="#b07d00" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.55"/>
<line x1="76" y1="165" x2="303" y2="186" stroke="#0a8f62" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#ah-teal)"/>
<text x="135" y="176" fill="#0a8f62" font-size="11">간접광 (튕긴 빛) L<tspan baseline-shift="sub" font-size="8">i</tspan></text>
<rect x="520" y="78" width="46" height="34" rx="5" fill="#eef0f7" stroke="#3d63e0" stroke-width="1.5"/>
<rect x="566" y="86" width="13" height="18" rx="2" fill="#3d63e0"/>
<text x="543" y="130" fill="#3d63e0" font-size="12" text-anchor="middle">카메라 (눈)</text>
<line x1="316" y1="184" x2="516" y2="100" stroke="#3d63e0" stroke-width="2.2" marker-end="url(#ah-blue)"/>
<text x="392" y="138" fill="#3d63e0" font-size="11">나가는 빛 ω<tspan baseline-shift="sub" font-size="8">o</tspan> = L<tspan baseline-shift="sub" font-size="8">o</tspan></text>
</svg>
<div class="scene-cap">점 x로 들어오는 빛(조명에서 곧장 오는 직접광 + 다른 표면에서 튕겨 온 간접광)을 재질이 카메라 방향 ω<sub>o</sub>로 반사해 보낸다. 이 한 점에서 일어나는 일을 계산하는 것이 렌더링의 핵심이다.</div>
</div>
<span class="section-eyebrow">01 — 방정식</span>
</div>

# 방정식: 직관을 한 줄로

<div class="re-post">
<div class="eq-block">
<div class="eq-label">Kajiya's Rendering Equation (1986)</div>
<div class="eq-main"><span class="eq-term">L<sub>o</sub>(x, ω<sub>o</sub>)</span> <span class="eq-op">=</span> <span class="eq-term">L<sub>e</sub>(x, ω<sub>o</sub>)</span> <span class="eq-op">+</span> <span class="eq-int">∫</span><sub>Ω</sub> <span class="eq-fn">f<sub>r</sub></span><span class="eq-op">(x, ω<sub>i</sub>, ω<sub>o</sub>)</span> · <span class="eq-term">L<sub>i</sub>(x, ω<sub>i</sub>)</span> · <span class="eq-fn">cos θ<sub>i</sub></span> <span class="eq-op">dω<sub>i</sub></span></div>
</div>
처음 보면 기호에 압도되지만, 각 조각은 방금 본 장면의 한 부분일 뿐이다. 왼쪽부터 천천히 말로 읽어보자.
<div class="eq-read">
<div class="eq-read-row"><div class="eq-read-sym">L<sub>o</sub>(x, ω<sub>o</sub>)</div><div class="eq-read-txt"><strong>점 x에서 카메라 방향 ω<sub>o</sub>로 나가는 빛.</strong> 우리가 구하려는 값 — 이게 곧 픽셀 색이 된다.</div></div>
<div class="eq-read-row"><div class="eq-read-sym">= L<sub>e</sub>(x, ω<sub>o</sub>)</div><div class="eq-read-txt"><strong>그 점이 스스로 내는 빛.</strong> 네온사인·모니터처럼 발광하는 재질이 아니면 0이다.</div></div>
<div class="eq-read-row"><div class="eq-read-sym">+ ∫<sub>Ω</sub> ( … ) dω<sub>i</sub></div><div class="eq-read-txt"><strong>"반구 Ω의 모든 입사 방향 ω<sub>i</sub>에 대해 더한다."</strong> 사방에서 들어오는 빛을 빠짐없이 합산한다는 뜻. 이 합산(적분)이 실시간 렌더링의 가장 큰 난제다.</div></div>
<div class="eq-read-row"><div class="eq-read-sym">f<sub>r</sub>(x, ω<sub>i</sub>, ω<sub>o</sub>)</div><div class="eq-read-txt"><strong>재질의 반응.</strong> ω<sub>i</sub>로 들어온 빛 중 ω<sub>o</sub> 방향으로 얼마를 되돌려 보내는지의 비율.</div></div>
<div class="eq-read-row"><div class="eq-read-sym">· L<sub>i</sub>(x, ω<sub>i</sub>)</div><div class="eq-read-txt"><strong>그 방향에서 들어오는 빛의 양.</strong> 조명에서 직접 오거나, 다른 표면에서 튕겨 온다.</div></div>
<div class="eq-read-row"><div class="eq-read-sym">· cos θ<sub>i</sub></div><div class="eq-read-txt"><strong>입사각 보정.</strong> 비스듬히 들어온 빛은 같은 양이라도 넓게 퍼져 약해진다.</div></div>
</div>
<p style="color:var(--text2);line-height:1.85;margin:0;">즉 적분 기호 안은 <strong style="color:var(--text);">(재질 반응 f<sub>r</sub>) × (들어온 빛 L<sub>i</sub>) × (입사각 보정 cosθ)</strong>의 곱이고, 이 곱을 모든 입사 방향에 대해 더한 뒤 스스로 내는 빛 L<sub>e</sub>를 보태면 끝이다. 이어지는 절에서 각 항을 하나씩 직관과 함께 본다.</p>
<span class="section-eyebrow">02 — 각 항</span>
</div>

# 각 항이 의미하는 것

<div class="re-post">
각 항을 일상적인 비유와 "에디터에서 만지던 그 값"에 연결해 보자.
<div class="term-grid">
<div class="term-card blue">
<div class="term-symbol">L<sub>o</sub>(x, ω<sub>o</sub>)</div>
<div class="term-name">나가는 빛 (Outgoing Radiance)</div>
<p class="term-desc">점 x에서 카메라 방향으로 나가는 빛의 총량. 최종적으로 픽셀에 찍히는 값이다. 방정식 전체가 이 하나를 구하기 위한 것이다.</p>
</div>
<div class="term-card gold">
<div class="term-symbol">L<sub>e</sub>(x, ω<sub>o</sub>)</div>
<div class="term-name">스스로 내는 빛 (Emitted)</div>
<p class="term-desc">재질 자체가 발광하면 더해지는 항. 모니터, 네온사인, 불꽃처럼 빛나는 오브젝트가 해당된다.
<span class="editor-link">에디터: Emissive 채널</span></p>
</div>
<div class="term-card teal">
<div class="term-symbol">f<sub>r</sub>(x, ω<sub>i</sub>, ω<sub>o</sub>)</div>
<div class="term-name">재질의 반응 (BRDF)</div>
<p class="term-desc">들어온 빛 중 카메라 방향으로 얼마가 반사되는지를 정하는 함수. 분필처럼 사방으로 퍼뜨리는 <strong>Diffuse</strong>와 거울처럼 한 방향으로 몰아주는 <strong>Specular</strong>의 합으로 이루어진다.
<span class="editor-link">에디터: BaseColor · Roughness · Metallic</span></p>
</div>
<div class="term-card coral">
<div class="term-symbol">L<sub>i</sub>(x, ω<sub>i</sub>)</div>
<div class="term-name">들어오는 빛 (Incoming)</div>
<p class="term-desc">어떤 방향 ω<sub>i</sub>에서 점 x로 들어오는 빛. 문제는 이 값 자체도 "다른 점이 내보낸 L<sub>o</sub>"라서, 구하려면 방정식을 또 풀어야 한다는 점이다.</p>
</div>
<div class="term-card purple">
<div class="term-symbol">cos θ<sub>i</sub></div>
<div class="term-name">입사각 보정 (Lambert)</div>
<p class="term-desc">손전등을 벽에 정면으로 비추면 동그랗고 밝지만, 비스듬히 비추면 같은 빛이 길게 퍼져 어두워진다. 그 감쇠를 법선과 입사 방향의 내적 dot(N, L)로 계산한다.</p>
</div>
<div class="term-card orange">
<div class="term-symbol">∫<sub>Ω</sub> dω<sub>i</sub></div>
<div class="term-name">반구 적분</div>
<p class="term-desc">표면 위 반구의 모든 방향에서 들어오는 빛을 다 더한다. 방향이 무한히 많고 L<sub>i</sub>마다 재귀가 필요하므로, 이 적분이 실시간 렌더링의 핵심 난제다.</p>
</div>
</div>
<details class="deep-dive">
<summary>더 깊이 — BRDF는 실제로 어떻게 생겼나 (Diffuse + Specular, D·G·F)</summary>
<div class="dd-body">
<p>UE5의 BRDF는 두 항의 합이다. <strong>Diffuse</strong>와 <strong>Specular</strong>.</p>
<p><strong>① Diffuse (기본은 Lambert)</strong> — 빛이 표면 안으로 들어갔다 사방으로 고르게 흩어져 나온다. BaseColor에 비례하고 보는 방향과 무관하다. 분필이나 종이가 여기 가깝다. (UE는 옵션으로 거친 표면용 diffuse 모델도 지원하지만, 기본값은 순수 Lambert다.)</p>
<p><strong>② Specular (Cook-Torrance 미세면 모델)</strong> — 빛이 표면에서 곧장 반사되어 특정 방향으로 몰린다. 하이라이트와 거울 반사가 여기서 나온다. 코드상으로는 f = D · Vis · F 형태이며, 여기서 Vis = G / (4·NoL·NoV)로 아래의 G항과 분모를 묶은 것이다.</p>
<p>· <strong>D (GGX / Trowbridge-Reitz)</strong> — 미세면 법선이 halfway 벡터와 얼마나 정렬돼 있는지의 분포. Roughness가 낮을수록 분포가 좁아져 하이라이트가 날카로워진다. (<code>BRDF.ush</code>의 <code>D_GGX</code>)</p>
<p>· <strong>G / Vis (Smith 높이상관 근사)</strong> — 미세면끼리 서로 가리고(shadowing) 막는(masking) 효과. UE는 <code>Vis_SmithJointApprox</code>라는 높이상관 <em>근사</em>를 쓴다. 측면에서 볼수록 약해지는 하이라이트를 설명한다.</p>
<p>· <strong>F (Fresnel-Schlick)</strong> — 비스듬히 볼수록 반사율이 올라가는 현상. 금속과 비금속의 반사 특성 차이도 이 항이 담당한다.</p>
<p>이 모델의 실시간 형태는 Epic의 "Real Shading in Unreal Engine 4"(SIGGRAPH 2013)에서 정립되었고, 5.7까지도 같은 Cook-Torrance 골격에 최신 항들이 더해진 형태다.</p>
</div>
</details>
<div class="callout callout-warn">
<div class="callout-title">⚡ 왜 어려운가</div>
<p>L<sub>i</sub>(x, ω<sub>i</sub>)를 구하려면 다시 렌더링 방정식을 풀어야 한다. 즉 빛은 재귀적으로 튕기고, 그 모든 경로를 끝까지 추적하면 무한 연산이 필요하다. 실시간 엔진은 이 무한 재귀를 영리하게 <strong>근사</strong>한다 — 다음 절이 그 방법이다.</p>
</div>
<span class="section-eyebrow">03 — 푸는 전략</span>
</div>

# 방정식을 공략하는 네 가지 전략

<div class="re-post">
<div class="intuition">
<p>이 방정식은 아주 단순한 장면을 빼면 해석적으로 풀 수 없다. PBR Book은 그 이유를 이렇게 요약한다 — <strong>"물리 기반 BSDF, 임의의 씬 지오메트리, 오브젝트 간의 복잡한 가시성 관계가 공모하여 수치적 해법을 강제한다."</strong> 그래서 오프라인 렌더러든 실시간 엔진이든 모든 렌더러는 결국 이 방정식의 근사 풀이 기계이고, 차이는 "얼마나 정직하게 푸느냐"의 정도뿐이다.</p>
<p>흥미로운 것은 이 관점이 후대의 해석이 아니라는 점이다. 카지야의 1986년 원논문 자체가 <strong>"기존 렌더링 알고리즘 전부를, 단일 방정식의 해에 대한 정확도가 다른 근사들로 바라보는 통일된 맥락"</strong>을 제공하겠다고 선언하며 시작한다. 실제로 그는 당시 알고리즘들을 방정식의 절단으로 분류했다: 스캔라인 셰이딩(Utah 근사)은 첫 산란만 남긴 것, Whitted 레이트레이싱은 BRDF를 거울(델타 함수)+확산으로 제한한 것, 라디오시티는 BRDF를 상수(완전 확산)로 제한한 것. 코드를 짤 때 "지금 방정식의 어느 항을 근사하고 있나"를 묻는 것은, 40년 전 원논문이 하던 질문 그대로다.</p>
</div>
<div class="eq-block">
<div class="eq-label">Neumann Series — 방정식을 풀어 헤치면</div>
<div class="eq-main"><span class="eq-term">L</span> <span class="eq-op">=</span> <span class="eq-term">L<sub>e</sub></span> <span class="eq-op">+</span> <span class="eq-fn">T</span> <span class="eq-term">L<sub>e</sub></span> <span class="eq-op">+</span> <span class="eq-fn">T²</span><span class="eq-term">L<sub>e</sub></span> <span class="eq-op">+</span> <span class="eq-fn">T³</span><span class="eq-term">L<sub>e</sub></span> <span class="eq-op">+ ⋯</span> <span class="eq-op" style="margin-left:18px;font-size:12px;">(T = 빛을 표면에서 한 번 튕기는 수송 연산자)</span></div>
</div>
<p style="color:var(--text2);line-height:1.85;">L<sub>i</sub>가 "다른 점의 L<sub>o</sub>"라는 재귀를 방정식 자신에 반복 대입하면 위와 같은 무한 급수가 나온다(Neumann 급수). 각 항의 물리적 의미가 명확하다: <strong style="color:var(--text);">L<sub>e</sub>는 광원이 직접 보이는 것, T L<sub>e</sub>는 광원에서 한 번 튕겨 눈에 온 빛(직접광), T² L<sub>e</sub>부터는 두 번 이상 튕긴 빛(간접광)</strong>. 표면은 받은 빛보다 많이 내보낼 수 없으므로(반사율 &lt; 1) 항은 갈수록 작아지고 급수는 수렴한다. "직접광과 간접광을 분리한다", "GI 바운스를 2회로 제한한다" 같은 익숙한 말들은 전부 이 급수를 어디서 어떻게 자르느냐에 대한 이야기다.</p>
<p style="color:var(--text2);line-height:1.85;">이 토대 위에서, 실시간 렌더링의 온갖 기법은 크게 네 가지 전략의 조합으로 정리된다.</p>
<div class="term-grid">
<div class="term-card blue">
<div class="term-symbol">전략 ① 분해</div>
<div class="term-name">Split — 적분을 쪼갠다</div>
<p class="term-desc">적분을 직접광/간접광, diffuse/specular, 광원 종류별로 쪼개고, 각 조각을 가장 잘 푸는 시스템에 따로 맡긴다. 이중 계산과 누락만 없으면 합은 여전히 정확하다(아래 콜아웃).</p>
</div>
<div class="term-card purple">
<div class="term-symbol">전략 ② 급수 절단</div>
<div class="term-name">Truncate — 무한 바운스를 끊는다</div>
<p class="term-desc">Neumann 급수를 유한 항에서 자른다. 구세대의 "직접광 + 앰비언트 상수"는 1차 절단이고, Lumen Surface Cache의 radiosity 피드백은 급수를 여러 프레임에 걸쳐 반복법으로 쌓는 방식이다.</p>
</div>
<div class="term-card gold">
<div class="term-symbol">전략 ③ 샘플링</div>
<div class="term-name">Monte Carlo — 유한 샘플로 대체한다</div>
<p class="term-desc">무한 방향의 ∫를 유한 N개 무작위 샘플의 평균 (1/N)·Σ f/p 로 대체한다. BRDF가 큰 방향에 샘플을 몰아주는 importance sampling으로 분산(노이즈)을 줄이고, 남은 노이즈는 시간·공간 필터로 정리한다.</p>
</div>
<div class="term-card teal">
<div class="term-symbol">전략 ④ 사전계산</div>
<div class="term-name">Precompute — 적분을 미리 해 둔다</div>
<p class="term-desc">적분의 일부를 미리 계산해 텍스처·캐시에 저장한다. split-sum LUT, 프리필터 큐브맵, 라이트맵, Lumen Surface Cache. 런타임 적분을 룩업으로 바꾼다.</p>
</div>
</div>
<div class="callout callout-info">
<div class="callout-title">💡 분해가 "합법"인 이유 — Partitioning the Integrand</div>
<p>적분을 마음대로 쪼개도 되는 근거는 적분의 선형성이고, PBR Book은 이를 명시적 원리로 승인한다: 경로 길이별(직접 vs 간접), BSDF 성분별(diffuse vs specular), 광원 종류별로 나눠 <strong>서로 다른 알고리즘이 각 조각을 처리해도, 이중 계산과 누락만 없으면 총합은 정확하다</strong>. UE5에서 직접광 패스·Lumen GI·Lumen Reflection·SkyLight가 완전히 별개 시스템인 것은 이 원리의 공학적 실현이다. 뒤집어 말하면 렌더링 밝기 버그의 단골 원인 — 어떤 빛이 두 시스템에 이중으로 잡히거나(너무 밝음) 어느 쪽에도 안 잡히는(너무 어두움) — 도 바로 이 분할 경계에서 나온다.</p>
</div>
<details class="deep-dive">
<summary>더 깊이 — split-sum: 반구 적분을 텍스처 두 번 읽기로 (Karis 2013)</summary>
<div class="dd-body">
<p>환경광(IBL)의 스펙큘러는 반구 적분 ∫ L<sub>i</sub>(l)·f(l,v)·cosθ<sub>l</sub> dl 을 요구한다. 원리대로면 GGX importance sampling으로 매 픽셀 수십 개 샘플이 필요하지만, Karis는 이 Monte Carlo 합을 <strong>두 개의 독립적인 합의 곱</strong>으로 근사했다: (1/N)Σ L<sub>i</sub> × (1/N)Σ f·cosθ/pdf.</p>
<p><strong>첫째 합</strong>은 조명 환경에만 의존하므로 큐브맵을 roughness별 밉 체인으로 미리 필터링해 두고, <strong>둘째 합</strong>은 재질에만 의존하므로 (NoV, Roughness)로 인덱싱되는 2D LUT(<code>PreIntegratedGF</code> 텍스처)에 미리 적분해 둔다. 런타임에는 텍스처 두 번 읽고 곱하면 끝 — 반구 적분이 사라진다. 전략 ③(샘플링)으로 정의한 추정량을 전략 ④(사전계산)로 오프라인에 옮긴 셈이다.</p>
<p>원문이 명시하는 정직한 한계 두 가지: 이 분리는 <strong>L<sub>i</sub>가 상수일 때 정확</strong>하고(조명이 균일할수록 오차가 없다), 프리필터 시 법선=뷰=반사 방향(n=v=r)으로 두는 등방 가정이 <strong>split 자체보다 더 큰 오차원</strong>이다 — 스치는 각도에서 길게 늘어나야 할 반사가 뭉툭해지는 것이 그 흔적이다.</p>
</div>
</details>
<details class="deep-dive">
<summary>더 깊이 — 그림자 항 V는 방정식 어디에 숨어 있나</summary>
<div class="dd-body">
<p>01절의 방정식에는 그림자 항이 안 보인다. 반구(방향) 형태에서 가시성은 L<sub>i</sub> 안에 숨어 있다: L<sub>i</sub>(x, ω<sub>i</sub>)는 "방향 ω<sub>i</sub>로 레이를 쐈을 때 처음 만나는 표면이 내보내는 L<sub>o</sub>"로 정의되므로, 레이캐스팅 자체가 가시성이다.</p>
<p>방정식을 방향이 아니라 표면점 사이의 관계로 다시 쓰면(3점 형태) 가시성이 명시적 항으로 튀어나온다: <strong>G(p↔p′) = V(p↔p′)·|cosθ||cosθ′| / ‖p−p′‖²</strong>. V는 두 점이 서로 보이면 1, 가려지면 0인 이진 함수이며, 카지야 원논문의 g(x,x′) 항이 그 원형이다. 섀도맵·VSM·스크린 트레이스는 이 V의 근사이고, 섀도 레이(레이트레이싱)는 근사가 아니라 V의 정확한 평가라는 점이 재미있는 차이다. 거리 감쇠 1/r²도 이 항의 식구다.</p>
</div>
</details>
<div class="analogy">
<div class="a-icon">🎯</div>
<div class="a-text"><strong>정공법과의 거리 재기.</strong> 방정식을 가장 정직하게 푸는 방법이 path tracing이다 — 카지야가 같은 1986년 논문에서 직접 명명한, 픽셀마다 확률적 경로를 따라가며 급수를 편향 없이 샘플링하는 방법이다. UE에도 들어 있다(Movie Render Queue의 Path Tracer). 흥미롭게도 그 정공법조차 직접광은 매 바운스에서 광원을 따로 샘플링하는 NEE(next event estimation)로 분리한다 — 실시간 렌더러의 직접/간접 분리(전략 ①)는 정공법 안에도 이미 있는 구조다. 05절에서 실제 코드로 비교한다.</div>
</div>
<span class="section-eyebrow">04 — UE5가 푸는 법</span>
</div>

# 언리얼 엔진5가 방정식을 푸는 방법

<div class="re-post">
UE5는 방정식을 한 번에 풀지 않고, 항별로 다른 시스템에 나눠 맡긴다. 완벽한 해가 아니라 "시각적으로 그럴듯한 근사"를 초당 60프레임으로 만드는 것이 목표다. 아래 6단계는 대체로 "쉬운 항 → 어려운 항" 순서다.
<div class="pipeline">
<div class="pipe-item">
<div class="pipe-num">01</div>
<div class="pipe-body">
<div class="step-badge badge-exact">Geometry</div>
<h3>무엇이 보이는가 — 재질 정보를 G-Buffer에 모은다</h3>
<p>조명을 계산하기 전에, 화면의 각 픽셀에 어떤 표면이 보이는지부터 정한다. 래스터라이저가 삼각형을 픽셀로 쪼개고, 각 픽셀의 재질 속성(법선 N, Roughness, Metallic, BaseColor)을 <strong>G-Buffer</strong>에 적어둔다. 아직 빛 계산은 하지 않는다 — 다음 단계가 f<sub>r</sub>와 cosθ를 계산할 '재료'를 모으는 셈이다.</p>
<p>Nanite 메시는 경로가 다르다. 래스터화 단계에서 픽셀마다 어떤 클러스터·삼각형이 보이는지를 64비트 Visibility Buffer(깊이 + ID)에 기록하고, 이어지는 컴퓨트 셰이딩 패스가 그 버퍼를 읽어 G-Buffer를 채운다. 덕분에 화면에 안 보이는 폴리곤을 셰이딩하는 낭비(overdraw)가 사라져, 폴리곤이 수백만 개여도 이 단계 비용이 화면 해상도에 수렴한다.</p>
<details class="deep-dive">
<summary>더 깊이 — 2×2 쿼드와 Nanite의 셰이딩 경로</summary>
<div class="dd-body">
<p><strong>2×2 쿼드.</strong> 재질 셰이더가 텍스처 밉 레벨을 고르려면 인접 픽셀 사이에서 UV가 얼마나 변하는지(<code>ddx</code>·<code>ddy</code>)를 알아야 한다. 그래서 GPU는 픽셀을 2×2 묶음으로 실행하고, 삼각형이 1픽셀만 덮어도 나머지 3개(helper pixel)를 함께 돌린다. 서브픽셀 삼각형이 많은 전통 래스터라이저에서 이 낭비가 특히 커진다.</p>
<p><strong>Nanite의 셰이딩 (UE 5.7).</strong> 5.7의 Nanite는 옛 MaterialDepth + 타일 쿼드 방식이 아니라 컴퓨트 셰이더(<code>ShadeGBufferCS</code>)로 G-Buffer를 채운다. 머티리얼이 미분(<code>ddx</code>·<code>ddy</code>)을 쓰지 않으면 픽셀당 1번(Pixel Binning)으로, 쓰면 2×2 쿼드 단위(Quad Binning)로 묶여 실행된다. 즉 "항상 쿼드"가 아니라 미분이 필요할 때만 쿼드로 묶이는 것이 핵심이다.</p>
</div>
</details>
<div class="pipe-tag-row">
<span class="pipe-tag tag-geo">Nanite Visibility</span>
<span class="pipe-tag tag-geo">Base Pass</span>
<span class="pipe-tag tag-geo">G-Buffer</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">02</div>
<div class="pipe-body">
<div class="step-badge badge-exact">Direct Light</div>
<h3>직접광 — 방향이 정해져 있어 적분이 합산으로 바뀐다</h3>
<p>Lighting Pass가 G-Buffer를 읽어 조명을 계산한다. 태양·포인트·스팟 같은 명시적 광원은 빛이 오는 방향 ω<sub>i</sub>가 하나로 정해져 있다. 그래서 반구 전체를 적분(∫)할 필요 없이 그 방향 하나만 계산하면 되고, 적분이 광원 수만큼의 단순 합산(Σ)으로 바뀐다. 광원마다 L<sub>i</sub>(빛의 세기) × f<sub>r</sub>(BRDF) × cosθ(= dot(N, L))를 곱해 더한다.</p>
<p>이 경로의 BRDF 계산 자체에는 몬테카를로 샘플링 같은 근사가 없어, 점·스팟·디렉셔널 광원의 직접광은 사실상 정확하게 계산된다. <strong>다만</strong> 면적 광원(Rect Light)은 LTC(Linear Transformed Cosines) 근사를 쓰고, 그림자·거리 감쇠에는 별도의 근사가 들어간다는 점은 짚어둘 만하다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-light">Direct Lighting</span>
<span class="pipe-tag tag-light">GGX BRDF</span>
<span class="pipe-tag tag-light">Deferred</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">03</div>
<div class="pipe-body">
<div class="step-badge badge-approx">GI Approximation</div>
<h3>Lumen — 다른 표면에서 튕겨 온 간접광 L<sub>i</sub> 근사</h3>
<p>가장 어려운 항: 직접광이 다른 표면에 닿고 거기서 다시 튕겨 들어오는 간접광. 정확히 풀려면 무한 재귀가 필요하므로, Lumen은 여러 기법을 계층적으로 조합해 근사한다.</p>
<p><strong>Surface Cache</strong> — 씬의 각 메시 표면에 '계산이 끝난 라이팅'(직접광·간접광 아틀라스)을 카드 형태로 캐시한다. 레이가 표면에 맞으면 이 캐시에서 그 지점의 밝기를 즉시 읽어 비싼 재계산을 피한다. 다중 바운스 간접광은 Radiosity가 이 캐시에서 레이를 쏴 누적한 뒤 다시 써넣는 방식으로 쌓인다.<br>
<strong>Screen Probe Gather</strong> — 화면에 약 16픽셀 간격 격자(+필요한 곳엔 적응형으로 추가)로 probe를 깔고, 각 probe가 씬으로 레이를 쏜다. 레이가 맞은 지점의 Surface Cache 라이팅을 모아 방향별 irradiance로 적분한다. 결과는 공간 필터(기본 3패스)와 시간적 누적(옵션)으로 노이즈를 정리한다.<br>
<strong>World-space Radiance Cache</strong> — 월드 공간에 sparse한 clipmap으로 둔 저주파 캐시. 화면 probe가 닿지 못하는 원거리 간접광을 보완한다.<br>
<strong>레이 추적 — 소프트웨어와 하드웨어</strong> — 소프트웨어 추적은 Lumen Scene(메시 카드·하이트필드·복셀)을 대상으로 전진하며, Distance Field는 주된 추적 수단이라기보다 occlusion과 가속에 쓰인다. RT 지원 GPU에서는 하드웨어 레이트레이싱이 가능하면 우선 쓰이고, 안 되면 소프트웨어 추적이 폴백이 된다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-gi">Lumen GI</span>
<span class="pipe-tag tag-gi">Surface Cache</span>
<span class="pipe-tag tag-gi">Screen Probe</span>
<span class="pipe-tag tag-gi">Radiance Cache</span>
<span class="pipe-tag tag-gi">SW / HW RT</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">04</div>
<div class="pipe-body">
<div class="step-badge badge-approx">Reflection</div>
<h3>반사 — Roughness가 낮을수록 집중된 방향의 L<sub>i</sub>가 필요하다</h3>
<p>BRDF의 D(GGX) 항은 Roughness가 낮을수록 specular lobe가 좁아진다. 즉 거울에 가까운 표면일수록 반사 방향 근방의 L<sub>i</sub>가 좁고 집중적으로 필요하다. 넓게 뭉뚱그린 GI 근사만으로는 이 방향의 빛을 충분한 해상도로 얻을 수 없어 별도의 추적이 필요하다.</p>
<p>Lumen Reflection은 GGX lobe를 중요도 샘플링해 반사 레이를 쏘며, 대체로 ① <strong>Screen Space Trace</strong>(화면 공간 레이, 맞으면 가장 저렴) → ② <strong>Lumen Scene 소프트웨어 추적</strong>(카드·하이트필드·복셀) → ③ <strong>Radiance Cache 보간</strong> → ④ <strong>하드웨어 RT</strong>(지원 시) 순으로 빛을 찾는다. 레이가 표면에 맞으면 그 지점의 라이팅은 Surface Cache에서 읽어 온다. Roughness가 높아질수록 lobe가 넓어져 GI와 반사의 경계가 흐려지고, 별도 추적의 필요성도 줄어든다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-gi">Lumen Reflection</span>
<span class="pipe-tag tag-gi">Screen Trace</span>
<span class="pipe-tag tag-gi">Radiance Cache</span>
<span class="pipe-tag tag-gi">Hardware RT</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">05</div>
<div class="pipe-body">
<div class="step-badge badge-approx">Shadow</div>
<h3>그림자 — 빛이 점 x에 실제로 도달하는가</h3>
<p>직접광에서 L<sub>i</sub>를 더하기 전에, 빛이 x까지 실제로 도달하는지 확인해야 한다. 무언가에 가려졌다면 그 방향의 L<sub>i</sub>는 0으로 처리한다(가시성 V).</p>
<p><strong>Virtual Shadow Maps (VSM)</strong> — 전통적 Shadow Map은 넓은 씬을 고해상도로 덮기 어렵다. VSM은 가상 텍스처링처럼 clipmap 구조로, 필요한 페이지만 고해상도로 생성한다. Nanite 메시도 VSM에 렌더링되어 픽셀 단위 정밀도의 그림자를 만든다. <strong>Distance Field Occlusion (DFAO)</strong> — 무버블 스카이라이트가 정적 메시에 드리우는 그림자를 SDF로 처리한다(범용 원거리 AO가 아니라 이 용도가 핵심이다). <strong>Ray Traced Shadow</strong> — 지원 시 레이트레이싱으로 정밀한 소프트 섀도우를 만든다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-shadow">Virtual Shadow Map</span>
<span class="pipe-tag tag-shadow">Distance Field Occlusion</span>
<span class="pipe-tag tag-shadow">Ray Traced Shadow</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">06</div>
<div class="pipe-body">
<div class="step-badge badge-hybrid">Post Process</div>
<h3>포스트 프로세스 — 최종 L<sub>o</sub>를 화면에 맞게 변환</h3>
<p>계산된 HDR Radiance 값을 실제 디스플레이에 맞게 변환한다. <strong>Tone Mapping</strong>은 HDR의 L<sub>o</sub>를 디스플레이가 표현할 수 있는 LDR 색으로 압축하고, <strong>Exposure</strong>는 카메라 노출을 시뮬레이션한다. <strong>Bloom</strong>은 매우 밝은 영역이 렌즈에서 인접 픽셀로 번지는 광학 효과로, 발광 오브젝트뿐 아니라 임계값 이상의 모든 밝은 영역에 적용된다. <strong>TSR(Temporal Super Resolution)</strong>은 낮은 해상도로 렌더링한 뒤 이전 프레임 데이터를 활용해 고해상도로 업스케일해 성능을 확보한다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-post">Tone Mapping</span>
<span class="pipe-tag tag-post">Bloom</span>
<span class="pipe-tag tag-post">TSR</span>
<span class="pipe-tag tag-post">TAA</span>
</div>
</div>
</div>
</div>
<span class="section-eyebrow">05 — 코드에서 방정식 찾기</span>
</div>

# 코드에서 방정식 찾기

<div class="re-post">
<p style="color:var(--text2);line-height:1.85;">여기까지의 대응이 은유가 아니라는 것을 소스로 확인하자. 아래는 UE 5.7.4 소스(<code>Engine/Shaders/Private/</code> 기준, 줄번호 포함)에서 방정식의 각 조각이 실제로 살고 있는 줄들이다. 셰이더 파일을 열 때 "이 함수는 방정식의 어느 항인가"를 붙여 읽으면, 낯선 코드도 지도를 든 채로 읽게 된다.</p>

<div style="margin:34px 0 0;">
<span class="step-badge badge-exact">f_r — 재질의 반응</span>
<div style="font-size:15.5px;font-weight:700;color:var(--text);margin:6px 0 8px;">① 스펙큘러 BRDF의 세 조각 — D · Vis · F</div>
<p style="font-size:14px;color:var(--text2);line-height:1.8;margin:0 0 4px;">방정식의 f<sub>r</sub> 중 스펙큘러 절반. 파일 주석부터 <code>f = D*G*F / (4*NoL*NoV) = D*Vis*F</code>라고 방정식을 문자 그대로 밝히고 있다. 호출부가 <code>a2 = Pow4(Roughness)</code>로 넘기는 것이 Karis 2013이 채택한 Disney 재매개화 α = Roughness²의 흔적이다(a2 = α²).</p>
<div class="code-block"><span class="code-lang">BRDF.ush : 311 · 373 · 403</span><span class="kw">float</span> <span class="fn">D_GGX</span>( float a2, float NoH )                <span class="cm">// D: 미세면 분포 (GGX) — 하이라이트의 '모양'</span>
{
    float d = ( NoH * a2 - NoH ) * NoH + 1;
    return a2 / ( PI*d*d );
}

<span class="kw">float</span> <span class="fn">Vis_SmithJointApprox</span>( float a2, float NoV, float NoL )   <span class="cm">// Vis = G / (4·NoL·NoV)</span>
{
    float a = sqrt(a2);
    float Vis_SmithV = NoL * ( NoV * ( 1 - a ) + a );
    float Vis_SmithL = NoV * ( NoL * ( 1 - a ) + a );
    return 0.5 * rcp( Vis_SmithV + Vis_SmithL );
}

<span class="kw">float3</span> <span class="fn">F_Schlick</span>( float3 SpecularColor, float VoH )           <span class="cm">// F: 프레넬</span>
{
    float Fc = Pow5( 1 - VoH );
    return saturate( 50.0 * SpecularColor.g ) * Fc + (1 - Fc) * SpecularColor;
}</div>
</div>

<div style="margin:34px 0 0;">
<span class="step-badge badge-exact">cos θ — 입사각 보정</span>
<div style="font-size:15.5px;font-weight:700;color:var(--text);margin:6px 0 8px;">② 피적분함수가 조립되는 두 줄 — f_r · cosθ</div>
<p style="font-size:14px;color:var(--text2);line-height:1.8;margin:0 0 4px;">적분 기호 안 f<sub>r</sub>·L<sub>i</sub>·cosθ 중 "재질 쪽 절반"이 여기서 완성된다. <code>AreaLight.NoL</code>이 dot(N, L), 곧 방정식의 cosθ다 — 수식의 기호가 변수명 하나로 코드에 존재한다.</p>
<div class="code-block"><span class="code-lang">ShadingModels.ush : 260 – 267</span><span class="cm">// DefaultLitBxDF 발췌 (5.7: "Deprecated by Substrate" 주석이 있으나 non-Substrate 경로에서 여전히 사용)</span>
Lighting.Diffuse  = <span class="fn">Diffuse_Lambert</span>( GBuffer.DiffuseColor );        <span class="cm">// f_r(diffuse) = albedo / π</span>
Lighting.Diffuse *= AreaLight.FalloffColor * (AreaLight.Falloff * AreaLight.NoL);
                                                    <span class="cm">// ↑ 감쇠 × cosθ — 방정식의 cosθ가 이 NoL</span>
Lighting.Specular = AreaLight.FalloffColor * (AreaLight.Falloff * AreaLight.NoL)
                  * <span class="fn">SpecularGGX</span>( GBuffer.Roughness, ..., Context, AreaLight );
                                                    <span class="cm">// ↑ cosθ × f_r(specular) = D·Vis·F (①)</span></div>
</div>

<div style="margin:34px 0 0;">
<span class="step-badge badge-exact">Σ · V — 직접광 합산과 그림자</span>
<div style="font-size:15.5px;font-weight:700;color:var(--text);margin:6px 0 8px;">③ 방정식이 한 줄로 완성되는 곳 — f_r·cosθ × L_i·감쇠 × V</div>
<p style="font-size:14px;color:var(--text2);line-height:1.8;margin:0 0 4px;">명시적 광원은 ω<sub>i</sub>가 정해져 있어 적분이 라이트 수만큼의 Σ가 된다(04절 2단계). 그 Σ의 몸통이 이 코드다. 마지막 호출 한 줄에서 피적분함수의 세 인수 — f<sub>r</sub>·cosθ(IntegrateBxDF), L<sub>i</sub>·감쇠(MaskedLightColor), V(SurfaceShadow) — 가 전부 곱해져 누적된다.</p>
<div class="code-block"><span class="code-lang">DeferredLightingCommon.ush : 333 – 433</span>float3 MaskedLightColor = LightData.Color;               <span class="cm">// L_i : 광원 radiance</span>
float LightMask = <span class="fn">GetLocalLightAttenuation</span>( ... );       <span class="cm">// 거리·스팟 감쇠 (3점 형태의 1/r² 항)</span>
MaskedLightColor *= LightMask;

<span class="fn">GetShadowTerms</span>( ..., Shadow );                           <span class="cm">// V : 가시성 — VSM/섀도레이가 채운다</span>
FDirectLighting Lighting = <span class="fn">IntegrateBxDF</span>( GBuffer, N, V, Capsule, Shadow, ... );
                                                         <span class="cm">// ↑ 내부에서 f_r·cosθ 계산 (②)</span>
<span class="fn">LightAccumulator_AddSplit</span>( LightAccumulator, Lighting.Diffuse, Lighting.Specular, Lighting.Diffuse,
    MaskedLightColor * Shadow.SurfaceShadow, ... );      <span class="cm">// f_r·cosθ × L_i·감쇠 × V — Σ 에 누적</span></div>
</div>

<div style="margin:34px 0 0;">
<span class="step-badge badge-approx">∫ — Monte Carlo</span>
<div style="font-size:15.5px;font-weight:700;color:var(--text);margin:6px 0 8px;">④ 적분을 샘플로 — importance sampling (전략 ③)</div>
<p style="font-size:14px;color:var(--text2);line-height:1.8;margin:0 0 4px;">반구 적분을 (1/N)Σ f/p 로 바꿀 때 샘플을 어느 방향에 쏠지 정하는 함수. 균일 난수 E를 GGX lobe 모양으로 뒤튼다 — Roughness가 낮을수록 CosTheta 식이 가팔라져 샘플이 반사 방향 근처로 몰린다. "BRDF가 큰 곳에 샘플을 몰아준다"가 코드 두 줄이다.</p>
<div class="code-block"><span class="code-lang">MonteCarlo.ush : 367 – 384</span><span class="cm">// PDF = D * NoH / (4 * VoH)</span>
float4 <span class="fn">ImportanceSampleGGX</span>( float2 E, float a2 )
{
    float Phi = 2 * PI * E.x;
    float CosTheta = sqrt( (1 - E.y) / ( 1 + (a2 - 1) * E.y ) );   <span class="cm">// 난수 → GGX 분포 방향</span>
    ...
    float PDF = D * CosTheta;
    return float4( H, PDF );                                       <span class="cm">// 방향과 pdf를 함께 반환</span>
}</div>
</div>

<div style="margin:34px 0 0;">
<span class="step-badge badge-approx">∫ 사전계산 — split-sum</span>
<div style="font-size:15.5px;font-weight:700;color:var(--text);margin:6px 0 8px;">⑤ 반구 적분이 텍스처 두 번 읽기로 (전략 ④)</div>
<p style="font-size:14px;color:var(--text2);line-height:1.8;margin:0 0 4px;">03절 deep-dive에서 본 split-sum의 실물. 첫째 합(프리필터 큐브맵)과 둘째 합(사전적분 LUT)이 서로 다른 줄에서 곱해진다.</p>
<div class="code-block"><span class="code-lang">BRDF.ush : 592 / ReflectionEnvironmentPixelShader.usf : 234 · 288</span><span class="cm">// [Karis 2013] 둘째 합: ∫ f·cosθ 를 (NoV, Roughness) 2D LUT로 사전적분</span>
half3 <span class="fn">EnvBRDF</span>( half3 SpecularColor, half Roughness, half NoV )
{
    float2 AB = Texture2DSampleLevel( PreIntegratedGF, ..., float2( NoV, Roughness ), 0 ).rg;
    return SpecularColor * AB.x + saturate( 50.0 * SpecularColor.g ) * AB.y;
}

<span class="cm">// ReflectionEnvironmentPixelShader.usf — 첫째 합 × 둘째 합</span>
Color.rgb += View.PreExposure * <span class="fn">GatherRadiance</span>( ..., R, GBuffer.Roughness, ... );
                                    <span class="cm">// 첫째 합: roughness별 밉으로 프리필터된 큐브맵의 Σ L_i</span>
Color.rgb *= <span class="fn">EnvBRDF</span>( SpecularColor, GBuffer.Roughness, NoV );
                                    <span class="cm">// 둘째 합: LUT 조회 — 반구 적분이 사라졌다</span></div>
</div>

<div style="margin:34px 0 0;">
<span class="step-badge badge-approx">∫ 간접광 — Lumen</span>
<div style="font-size:15.5px;font-weight:700;color:var(--text);margin:6px 0 8px;">⑥ Lumen의 diffuse 적분 — probe에서 L_i를 조달하는 Monte Carlo</div>
<p style="font-size:14px;color:var(--text2);line-height:1.8;margin:0 0 4px;">04절에서 본 Screen Probe Gather의 몸통. 구조는 직접광(③)과 똑같은 f<sub>r</sub>·L<sub>i</sub>·cosθ인데, <strong>L<sub>i</sub>를 라이트 파라미터가 아니라 probe가 모아 온 radiance에서 읽는 것만 다르다</strong>. 방정식 입장에서 직접광과 간접광의 차이는 "L<sub>i</sub>를 어디서 조달하는가"뿐임을 코드가 보여준다.</p>
<div class="code-block"><span class="code-lang">LumenScreenProbeGather.usf : 1321 – 1346 / DiffuseIndirectComposite.usf : 631</span><span class="cm">// 반구를 N개 코사인 가중 방향으로 Monte Carlo 적분</span>
for (uint PixelRayIndex = 0; PixelRayIndex &lt; NumPixelSamples; PixelRayIndex += 1)
{
    FBxDFSample BxDFSample = <span class="fn">SampleBxDFWrapper</span>( TermMask, Material, V, E );   <span class="cm">// 방향 표본 (~cosθ/π)</span>
    float3 Radiance = <span class="fn">InterpolateFromScreenProbes</span>( BxDFSample.L, ... );       <span class="cm">// 그 방향의 L_i — probe에서</span>
    DiffuseLighting += Radiance * BxDFSample.Weight * DirectionVisibility;    <span class="cm">// Σ L_i·(f·cosθ/pdf)</span>
}
DiffuseLighting = DiffuseLighting * PI / ((float)NumPixelSamples);            <span class="cm">// Monte Carlo 정규화</span>

<span class="cm">// DiffuseIndirectComposite.usf — 적분된 irradiance × albedo = 최종 diffuse GI</span>
IndirectLighting.Diffuse = (DiffuseIndirectLighting * DiffuseColor + ...) * Occlusion.DiffuseOcclusion * ...;</div>
</div>

<div style="margin:34px 0 0;">
<span class="step-badge badge-exact">L_e — 방출</span>
<div style="font-size:15.5px;font-weight:700;color:var(--text);margin:6px 0 8px;">⑦ 가장 정직한 항</div>
<div class="code-block"><span class="code-lang">BasePassPixelShader.usf : 1630 · 1691</span>Emissive = <span class="fn">GetMaterialEmissive</span>(PixelMaterialInputs);
...
Color += Emissive;    <span class="cm">// L_o 에 L_e 를 그대로 더한다 — 방정식에서 근사 없이 구현되는 유일한 항</span></div>
</div>

<div style="margin:34px 0 0;">
<span class="step-badge badge-hybrid">정공법 — Path Tracer</span>
<div style="font-size:15.5px;font-weight:700;color:var(--text);margin:6px 0 8px;">⑧ 같은 엔진 안의 대조군 — 급수를 경로로 그대로 샘플링</div>
<p style="font-size:14px;color:var(--text2);line-height:1.8;margin:0 0 4px;">실시간 경로가 항별로 흩어 놓은 방정식이, path tracer에서는 한 루프에 그대로 모여 있다. Neumann 급수의 n번째 항 = bounce 루프의 n번째 반복이고, <code>PathThroughput</code>은 경로를 따라 누적된 ∏(f<sub>r</sub>·cosθ/pdf)다. 실시간 렌더러를 읽던 눈으로 이 코드를 읽으면, 두 세계가 같은 방정식의 두 가지 풀이임이 선명해진다.</p>
<div class="code-block"><span class="code-lang">PathTracing.usf : 161 / PathTracingCore.ush : 1543 – 1573</span><span class="cm">// bounce 루프 — 급수를 경로 하나로 샘플링</span>
for (int Bounce = FirstBounce; Bounce &lt;= MaxBounces; Bounce++)
{
    if (!<span class="fn">PathTracingKernel</span>(PathState, Bounce)) break;
}

<span class="cm">// PathTracingCore.ush — 매 바운스의 직접광(NEE): throughput × L_i/pdf × f_r·cosθ × V</span>
float3 LightContrib = PathState.PathThroughput * LightSample.RadianceOverPdf
                    * MaterialEval.Weight * MaterialEval.Pdf;
LightContrib *= <span class="fn">TraceTransparentVisibilityRay</span>( ... );    <span class="cm">// V 를 레이로 '정확히' 평가</span>
PathState.<span class="fn">AccumulateRadiance</span>(LightContrib);

<span class="cm">// throughput ·= f_r·cosθ/pdf — 다음 bounce로 전파 (급수의 다음 항)</span>
float3 NextPathThroughput = PathState.PathThroughput * MaterialSample.Weight;</div>
</div>

<div class="callout callout-warn">
<div class="callout-title">⚡ 버전 주의</div>
<p>줄번호는 UE 5.7.4 체크아웃 기준이며 버전에 따라 이동한다. 5.7의 ShadingModels.ush 레거시 BxDF 함수들에는 "Deprecated by Substrate" 주석이 붙어 있다 — Substrate 재질을 켠 프로젝트에서는 같은 역할을 Substrate 계열 셰이더가 맡지만, D·Vis·F의 곱, NoL 곱셈, 라이트별 Σ라는 <strong>구조 자체는 동일하다</strong>. 인용 코드는 가독성을 위해 일부 줄을 생략(...)했다.</p>
</div>
<span class="section-eyebrow">06 — 한 프레임의 실행 순서</span>
</div>

# 한 프레임 안에서는 이런 순서로 일어난다

<div class="re-post">
앞 절이 "방정식의 어느 항을 누가 맡는가"였다면, 이 절은 "한 프레임 동안 GPU가 실제로 어떤 순서로 거치는가"다. CPU가 무엇을 그릴지 추려서(InitViews) GPU로 넘기면, GPU는 기하 → 조명 → 출력 순으로 진행한다.
<div style="overflow-x:auto;margin:28px 0;">
<div style="display:flex;flex-direction:column;gap:0;min-width:560px;">
<div style="display:grid;grid-template-columns:180px 1fr;gap:0;border:1px solid rgba(60,80,180,0.12);border-radius:12px 12px 0 0;overflow:hidden;">
<div style="background:rgba(61,99,224,0.06);border-right:1px solid rgba(60,80,180,0.12);padding:20px 18px;">
<div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--accent);margin-bottom:6px;">CPU Stage</div>
<div style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;">InitViews</div>
<div style="font-size:12px;color:var(--text3);">Culling · 분류 · DrawCmd</div>
</div>
<div style="padding:20px 22px;display:flex;flex-direction:column;gap:6px;">
<div style="font-size:13px;font-weight:700;color:var(--text);">x를 결정한다 — 방정식을 어디서 풀지 정한다</div>
<div style="font-size:13px;color:var(--text2);margin-bottom:10px;">방정식의 x는 "빛을 계산할 표면 위의 점"이다. 화면에 안 보이거나 기여가 없는 점까지 계산하면 낭비이므로, InitViews는 아래 과정을 순서대로 거쳐 x 후보를 좁혀 나간다.</div>
<div style="display:flex;flex-direction:column;gap:5px;">
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent);"><span style="font-weight:700;color:var(--accent);margin-right:6px;">Frustum Culling</span>카메라의 시야각(절두체) 밖에 있는 오브젝트를 통째로 제거한다. 가장 먼저, 가장 빠르게 걸러낸다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent);"><span style="font-weight:700;color:var(--accent);margin-right:6px;">Distance Culling</span>MaxDrawDistance를 초과한 오브젝트를 제거한다. 멀어서 픽셀에 기여가 없는 x를 미리 솎아낸다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent);"><span style="font-weight:700;color:var(--accent);margin-right:6px;">Occlusion Culling (HZB)</span>이전 프레임의 Hierarchical Z-Buffer를 활용해 다른 오브젝트에 완전히 가려진 오브젝트를 제거한다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent);"><span style="font-weight:700;color:var(--accent);margin-right:6px;">Draw Command 생성</span>살아남은 오브젝트가 어떤 패스에 참여할지 분류하고, GPU에 넘길 드로우 커맨드와 셰이더(f<sub>r</sub>)를 준비한다.</div>
</div>
<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(61,99,224,0.10);color:var(--accent);font-weight:600;">방정식 전처리</span>
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(136,144,170,0.12);color:var(--text3);font-weight:600;">계산 불필요한 x 제거</span>
</div>
</div>
</div>
<div style="display:flex;align-items:center;justify-content:center;height:28px;border-left:1px solid rgba(60,80,180,0.12);border-right:1px solid rgba(60,80,180,0.12);">
<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2v10M4 8l4 4 4-4" fill="none" stroke="#8890aa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
</div>
<div style="display:grid;grid-template-columns:180px 1fr;gap:0;border:1px solid rgba(60,80,180,0.12);border-top:none;overflow:hidden;">
<div style="background:rgba(114,72,212,0.06);border-right:1px solid rgba(60,80,180,0.12);padding:20px 18px;">
<div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--accent2);margin-bottom:6px;">GPU Stage 1</div>
<div style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;">Base Pass</div>
<div style="font-size:12px;color:var(--text3);">래스터라이제이션 · G-Buffer</div>
</div>
<div style="padding:20px 22px;display:flex;flex-direction:column;gap:6px;">
<div style="font-size:13px;font-weight:700;color:var(--text);">삼각형을 픽셀로 쪼개고, f<sub>r</sub>·cosθ의 재료를 G-Buffer에 저장한다</div>
<div style="font-size:13px;color:var(--text2);">래스터라이저가 3D 삼각형을 2D 픽셀로 변환하고 UV·Normal을 보간한다. 각 픽셀에서 재질 셰이더가 보간된 UV로 텍스처를 샘플링해, 결과인 Normal(N)·Roughness·Metallic·BaseColor를 G-Buffer에 저장한다. 이 값들은 다음 Lighting Pass에서 f<sub>r</sub>와 cosθ를 계산할 재료가 된다. f<sub>r</sub> 계산 자체는 아직 일어나지 않는다. (2×2 쿼드와 Nanite 셰이딩 경로의 세부는 04절 1단계의 접이식 설명을 참고.)</div>
<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(114,72,212,0.10);color:var(--accent2);font-weight:600;">G-Buffer 쓰기</span>
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(136,144,170,0.12);color:var(--text3);font-weight:600;">f_r 입력값 저장</span>
</div>
</div>
</div>
<div style="display:flex;align-items:center;justify-content:center;height:28px;border-left:1px solid rgba(60,80,180,0.12);border-right:1px solid rgba(60,80,180,0.12);">
<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2v10M4 8l4 4 4-4" fill="none" stroke="#8890aa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
</div>
<div style="display:grid;grid-template-columns:180px 1fr;gap:0;border:1px solid rgba(60,80,180,0.12);border-top:none;overflow:hidden;position:relative;">
<div style="position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#0a8f62,transparent);"></div>
<div style="background:rgba(10,143,98,0.06);border-right:1px solid rgba(60,80,180,0.12);padding:20px 18px;">
<div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--teal);margin-bottom:6px;">GPU Stage 2 ★</div>
<div style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;">Lighting Pass</div>
<div style="font-size:12px;color:var(--text3);">Direct · Lumen</div>
</div>
<div style="padding:20px 22px;display:flex;flex-direction:column;gap:6px;">
<div style="font-size:13px;font-weight:700;color:var(--text);">L<sub>i</sub>를 모으고, f<sub>r</sub>로 반응하고, cosθ를 곱해 반구를 합산한다</div>
<div style="font-size:13px;color:var(--text2);">방정식을 실제로 푸는 단계. G-Buffer를 읽어 N·Roughness·Metallic을 가져온 뒤, 직접광과 Lumen 간접광에서 L<sub>i</sub>를 수집한다. 최종 반사광 = <strong>들어온 빛(L<sub>i</sub>)</strong> × <strong>재질의 반응(f<sub>r</sub>)</strong> × <strong>입사각 보정(cosθ)</strong>. 이 셋을 곱해야 "이 방향에서 온 빛이 카메라 방향으로 얼마나 나가는가"가 된다. 직접광·간접광·반사·그림자가 어떻게 나뉘는지는 04절에서, 이 곱셈이 코드 어느 줄인지는 05절에서 다뤘다.</div>
<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(10,143,98,0.12);color:var(--teal);font-weight:600;">방정식 실제 계산</span>
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(10,143,98,0.08);color:var(--teal);font-weight:600;">f_r · L_i · cosθ dω</span>
</div>
</div>
</div>
<div style="display:flex;align-items:center;justify-content:center;height:28px;border-left:1px solid rgba(60,80,180,0.12);border-right:1px solid rgba(60,80,180,0.12);">
<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2v10M4 8l4 4 4-4" fill="none" stroke="#8890aa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
</div>
<div style="display:grid;grid-template-columns:180px 1fr;gap:0;border:1px solid rgba(60,80,180,0.12);border-top:none;border-radius:0 0 12px 12px;overflow:hidden;">
<div style="background:rgba(200,90,0,0.06);border-right:1px solid rgba(60,80,180,0.12);padding:20px 18px;">
<div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--orange);margin-bottom:6px;">GPU Stage 3</div>
<div style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;">Output Merger</div>
<div style="font-size:12px;color:var(--text3);">ROP · Depth · Blend</div>
</div>
<div style="padding:20px 22px;display:flex;flex-direction:column;gap:6px;">
<div style="font-size:13px;font-weight:700;color:var(--text);">L<sub>o</sub>를 픽셀에 기록한다 — 방정식의 결과값 저장</div>
<div style="font-size:13px;color:var(--text2);">계산된 L<sub>o</sub>(최종 복사 휘도)를 픽셀 색상으로 framebuffer에 기록한다. Depth Test로 앞에 있는 표면만 남기고, Alpha Blending으로 반투명을 합산한다. 이후 Tone Mapping이 HDR 값의 L<sub>o</sub>를 디스플레이가 표현할 수 있는 색으로 변환한다.</div>
<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(200,90,0,0.10);color:var(--orange);font-weight:600;">render target 기록</span>
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(136,144,170,0.12);color:var(--text3);font-weight:600;">Depth · Blend · ROP</span>
</div>
</div>
</div>
</div>
</div>
<div class="callout callout-info">
<div class="callout-title">💡 파이프라인 → 방정식 항 대응 요약</div>
<p>렌더링 방정식 L<sub>o</sub> = L<sub>e</sub> + ∫ f<sub>r</sub> · L<sub>i</sub> · cosθ dω<sub>i</sub>를 파이프라인에 대응하면 — <strong>InitViews</strong>가 x를 결정하고, <strong>Base Pass</strong>가 삼각형을 픽셀로 변환하면서 f<sub>r</sub>·cosθ의 재료(N, Roughness, Metallic)를 G-Buffer에 저장하고, <strong>Lighting Pass</strong>가 G-Buffer를 읽어 L<sub>i</sub>를 모아 적분을 실제로 계산하고, <strong>Output Merger</strong>가 결과 L<sub>o</sub>를 픽셀에 기록한다.</p>
</div>
<span class="section-eyebrow">07 — 1:1 대응</span>
</div>

# 방정식 항 ↔ UE5 시스템 매핑

<div class="re-post">
<div style="overflow-x:auto;">
<table class="mapping-table" style="min-width:820px;">
<thead>
<tr>
<th>방정식 항</th>
<th>물리적 의미</th>
<th>UE5 구현</th>
<th>방식 (전략)</th>
<th>코드 위치 (UE 5.7.4)</th>
</tr>
</thead>
<tbody>
<tr>
<td class="math-cell">L<sub>o</sub>(x, ω<sub>o</sub>)</td>
<td class="desc-cell">최종 픽셀 색</td>
<td class="ue5-cell">Final Color Buffer</td>
<td class="desc-cell">모든 항의 합산 결과</td>
<td class="desc-cell"><code>LightAccumulator</code> → SceneColor</td>
</tr>
<tr>
<td class="math-cell">L<sub>e</sub>(x, ω<sub>o</sub>)</td>
<td class="desc-cell">재질 자체 발광</td>
<td class="ue5-cell">Emissive Channel</td>
<td class="desc-cell">근사 없이 직접 가산</td>
<td class="desc-cell"><code>BasePassPixelShader.usf:1691</code></td>
</tr>
<tr>
<td class="math-cell">f<sub>r</sub>(x, ω<sub>i</sub>, ω<sub>o</sub>)</td>
<td class="desc-cell">BRDF (재질 반응)</td>
<td class="ue5-cell">PBR Material (GGX Specular + Lambert Diffuse)</td>
<td class="desc-cell">Karis 2013 실시간 근사 (f = D·Vis·F)</td>
<td class="desc-cell"><code>BRDF.ush:311·373·403</code>, <code>ShadingModels.ush:180</code></td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (직접광)</td>
<td class="desc-cell">광원에서 직접 오는 빛</td>
<td class="ue5-cell">Directional / Point / Spot Light</td>
<td class="desc-cell">ω<sub>i</sub> 고정 → ∫가 광원 수만큼의 Σ로 (분해①, 면적광은 LTC 근사)</td>
<td class="desc-cell"><code>DeferredLightingCommon.ush:333–433</code></td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (간접광)</td>
<td class="desc-cell">다른 표면에서 반사된 빛</td>
<td class="ue5-cell">Lumen GI (Surface Cache · Screen Probe · Radiance Cache · SW/HW RT)</td>
<td class="desc-cell">probe 기반 Monte Carlo③ + 캐시④ + 시·공간 필터</td>
<td class="desc-cell"><code>LumenScreenProbeGather.usf:1343</code> → <code>DiffuseIndirectComposite.usf:631</code></td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (반사)</td>
<td class="desc-cell">specular lobe 방향의 집중된 빛</td>
<td class="ue5-cell">Lumen Reflection (Screen Trace → Lumen Scene → Radiance Cache → HW RT)</td>
<td class="desc-cell">GGX importance sampling③, Roughness 낮을수록 별도 추적 필요</td>
<td class="desc-cell"><code>MonteCarlo.ush:368</code> (ImportanceSampleGGX)</td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (환경광)</td>
<td class="desc-cell">Sky / IBL</td>
<td class="ue5-cell">Sky Atmosphere + SkyLight</td>
<td class="desc-cell">split-sum 사전적분④ (Karis 2013)</td>
<td class="desc-cell"><code>BRDF.ush:592</code> (EnvBRDF), <code>ReflectionEnvironmentPixelShader.usf:234·288</code></td>
</tr>
<tr>
<td class="math-cell">cos θ<sub>i</sub></td>
<td class="desc-cell">Lambert 코사인 항</td>
<td class="ue5-cell">N · L (Shader 내적 연산)</td>
<td class="desc-cell">근사 없이 내적 한 번</td>
<td class="desc-cell"><code>ShadingModels.ush:262·267</code> (<code>* AreaLight.NoL</code>)</td>
</tr>
<tr>
<td class="math-cell">V(x, ω<sub>i</sub>)</td>
<td class="desc-cell">가시성 (그림자)</td>
<td class="ue5-cell">VSM · DFAO(스카이라이트) · RT Shadow</td>
<td class="desc-cell">복수 시스템 조합, 가려지면 L<sub>i</sub> = 0</td>
<td class="desc-cell"><code>DeferredLightingCommon.ush:352·433</code> (<code>Shadow.SurfaceShadow</code> 곱)</td>
</tr>
<tr>
<td class="math-cell">∫<sub>Ω</sub> dω<sub>i</sub></td>
<td class="desc-cell">반구 적분</td>
<td class="ue5-cell">직접광 → Σ 합산 / 간접광 → Lumen probe · 환경맵 사전적분 · 시간적 누적</td>
<td class="desc-cell">네 전략의 총동원 — 분해①·절단②·샘플링③·사전계산④</td>
<td class="desc-cell"><code>MonteCarlo.ush:368</code>, <code>LumenScreenProbeGather.usf:1346</code></td>
</tr>
</tbody>
</table>
</div>
</div>

# 마치며

<div class="re-post">
<div class="summary-box">
<h3>모든 렌더러는 같은 방정식의 서로 다른 근사다</h3>
<p> 카지야의 방정식은 빛의 물리를 한 줄로 기술하지만, 일반적인 장면에서는 해석적으로 풀리지 않는다. 그래서 모든 렌더러는 근사 기계이고 — 카지야 스스로 1986년에 당시의 모든 렌더링 알고리즘을 "한 방정식에 대한 정확도가 다른 근사들"로 분류했다 — UE5도 같은 계보에 있다. 적분을 분해하고(직접광 패스 / Lumen GI / Reflection / SkyLight), 급수를 절단·캐시하고(Surface Cache), 샘플링하고(importance sampling + 시·공간 필터), 사전계산한다(split-sum LUT). 그러니 렌더링 코드를 읽고 쓸 때 가장 힘이 센 질문은 이것이다: <strong>"이 코드는 지금 방정식의 어느 항을, 어떤 전략으로 근사하고 있나?"</strong> 이 답을 쥐고 있으면 새 기법이 나와도 지도 위 어디에 꽂히는지 보이고, 화면이 너무 밝거나 어두운 버그가 나도 어느 분할 경계에서 이중 계산·누락이 생겼는지부터 짚을 수 있다. 이것이 "Physically Based Rendering"의 본질이다 — 물리를 흉내 내되, 어디를 근사했는지 아는 채로. </p>
</div>
</div>

**참고 문헌**

- James T. Kajiya, ["The Rendering Equation"](https://dl.acm.org/doi/10.1145/15886.15902), SIGGRAPH 1986 — 방정식의 원전. path tracing의 명명, 그리고 "모든 렌더링 알고리즘 = 한 방정식의 근사"라는 이 글의 관점 자체의 출처.
- Brian Karis, ["Real Shading in Unreal Engine 4"](https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf), SIGGRAPH 2013 Physically Based Shading Course — UE의 GGX 채택, Disney α=Roughness² 재매개화, split-sum 근사의 출처.
- Matt Pharr, Wenzel Jakob, Greg Humphreys, [*Physically Based Rendering* 4th ed., ch. 13 "Light Transport I"](https://pbr-book.org/4ed/Light_Transport_I_Surface_Reflection/The_Light_Transport_Equation) — Neumann 급수, 3점 형태의 가시성 항 G(p↔p′), Partitioning the Integrand의 형식적 전개.
- Eric Heitz, "Understanding the Masking-Shadowing Function in Microfacet-Based BRDFs", JCGT 2014 — Vis_SmithJointApprox(높이 상관 Smith)의 계보.
- Daniel Wright et al., "Lumen: Real-time Global Illumination in Unreal Engine 5", SIGGRAPH 2022 Advances in Real-Time Rendering course.
- 코드 인용은 Unreal Engine 5.7.4 소스 <code>Engine/Shaders/Private/</code> 기준 (줄번호는 버전에 따라 이동).
