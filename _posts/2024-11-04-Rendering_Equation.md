---
layout: post
title: "언리얼 엔진에서 렌더링 방정식 이해하기: 현실감을 더하는 기술적 접근"
icon: paper
permalink: d8c73243c492ed7b5f44b70936cfe4521669ad34
categories: Rendering
tags: [Rendering, UnrealEngine]
excerpt: "Rendering Equation"
back_color: "#ffffff"
img_name: "black.webp"
toc: false
show: true
new: true
series: -1
index: 0
---

**이런 분이 읽으면 좋습니다!**

- 언리얼 엔진5를 사용하면서 빛이 어떻게 계산되는지 궁금했던 분
- PBR, Lumen, Nanite 같은 용어가 수학적으로 어떤 의미인지 알고 싶은 분

**이 글로 알 수 있는 내용**

- 카지야 렌더링 방정식의 각 항이 무엇을 의미하는지
- UE5의 Nanite, Lumen, VSM이 방정식의 어느 부분을 담당하는지
- UE5 PBR 재질(GGX BRDF)이 수학적으로 어떻게 작동하는지

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style> .re-post { --bg2: #f4f6fb; --bg3: #eef0f7; --surface: #f9fafd; --surface2: #eceef7; --border: rgba(60,80,180,0.10); --border2: rgba(60,80,180,0.22); --text: #1a1d2e; --text2: #464c6a; --text3: #8890aa; --accent: #3d63e0; --accent2: #7248d4; --gold: #b07d00; --teal: #0a8f62; --coral: #d63031; --orange: #c85a00; } .re-post .eq-block { position: relative; background: var(--bg2); border: 1px solid var(--border2); border-radius: 16px; padding: 32px 40px; margin: 24px 0 40px; overflow-x: auto; overflow-y: hidden; font-family: 'JetBrains Mono', monospace; } .re-post .eq-block::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent); } .re-post .eq-label { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--text3); margin-bottom: 16px; } .re-post .eq-main { font-size: clamp(13px, 2.5vw, 16px); color: var(--text); line-height: 2.2; white-space: nowrap; word-break: normal; min-width: max-content; } .re-post .eq-term { color: var(--accent); font-weight: 600; } .re-post .eq-op { color: var(--text3); } .re-post .eq-fn { color: var(--teal); font-weight: 600; } .re-post .eq-int { color: var(--gold); font-size: 1.3em; } .re-post .section-eyebrow { display: block; font-size: 12px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: var(--accent); margin-bottom: 4px; margin-top: 56px; } .re-post .term-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin: 28px 0; } .re-post .term-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; position: relative; overflow: hidden; transition: border-color 0.2s, box-shadow 0.2s; } .re-post .term-card:hover { border-color: var(--border2); box-shadow: 0 2px 12px rgba(60,80,180,0.07); } .re-post .term-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; } .re-post .term-card.blue::before { background: var(--accent); } .re-post .term-card.gold::before { background: var(--gold); } .re-post .term-card.teal::before { background: var(--teal); } .re-post .term-card.coral::before { background: var(--coral); } .re-post .term-card.purple::before { background: var(--accent2); } .re-post .term-card.orange::before { background: var(--orange); } .re-post .term-symbol { font-family: 'JetBrains Mono', monospace; font-size: 17px; font-weight: 600; margin-bottom: 6px; } .re-post .term-card.blue .term-symbol { color: var(--accent); } .re-post .term-card.gold .term-symbol { color: var(--gold); } .re-post .term-card.teal .term-symbol { color: var(--teal); } .re-post .term-card.coral .term-symbol { color: var(--coral); } .re-post .term-card.purple .term-symbol { color: var(--accent2); } .re-post .term-card.orange .term-symbol { color: var(--orange); } .re-post .term-name { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 4px; } .re-post .term-desc { font-size: 13px; color: var(--text2); line-height: 1.65; margin: 0; } .re-post .pipeline { display: flex; flex-direction: column; margin: 28px 0; position: relative; } .re-post .pipeline::before { content: ''; position: absolute; left: 27px; top: 54px; bottom: 54px; width: 1px; background: linear-gradient(to bottom, var(--accent), var(--accent2)); opacity: 0.25; } .re-post .pipe-item { display: grid; grid-template-columns: 54px 1fr; gap: 18px; padding: 20px 0; position: relative; } .re-post .pipe-num { width: 54px; height: 54px; border-radius: 50%; border: 1px solid var(--border2); background: var(--surface); display: flex; align-items: center; justify-content: center; font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600; color: var(--accent); flex-shrink: 0; position: relative; z-index: 1; } .re-post .pipe-body h3 { font-size: 1rem; font-weight: 700; color: var(--text); margin-bottom: 6px; } .re-post .pipe-body p { font-size: 14px; color: var(--text2); line-height: 1.75; margin: 0; } .re-post .pipe-tag-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; } .re-post .pipe-tag { font-size: 11px; padding: 3px 10px; border-radius: 100px; font-weight: 600; letter-spacing: 0.04em; } .re-post .tag-geo { background: rgba(61,99,224,0.10); color: var(--accent); } .re-post .tag-light { background: rgba(176,125,0,0.10); color: var(--gold); } .re-post .tag-gi { background: rgba(10,143,98,0.10); color: var(--teal); } .re-post .tag-shadow { background: rgba(114,72,212,0.10); color: var(--accent2); } .re-post .tag-post { background: rgba(200,90,0,0.10); color: var(--orange); } .re-post .step-badge { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; margin-bottom: 4px; } .re-post .badge-approx { background: rgba(200,90,0,0.12); color: var(--orange); } .re-post .badge-exact { background: rgba(10,143,98,0.12); color: var(--teal); } .re-post .badge-hybrid { background: rgba(61,99,224,0.12); color: var(--accent); } .re-post .mapping-table { width: 100%; border-collapse: collapse; margin: 28px 0; font-size: 14px; } .re-post .mapping-table th { background: var(--surface2); padding: 10px 14px; text-align: left; font-weight: 700; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text3); border: 1px solid var(--border); } .re-post .mapping-table td { padding: 12px 14px; border: 1px solid var(--border); vertical-align: top; line-height: 1.6; } .re-post .mapping-table tr { background: #ffffff; } .re-post .mapping-table tr:nth-child(odd) { background: var(--surface); } .re-post .mapping-table tr:hover { background: var(--surface2); } .re-post .math-cell { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--accent); font-weight: 600; } .re-post .ue5-cell { color: var(--teal); font-weight: 600; } .re-post .desc-cell { color: var(--text2); } .re-post .callout { border-radius: 12px; padding: 18px 22px; margin: 24px 0; border: 1px solid; position: relative; overflow: hidden; } .re-post .callout::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; } .re-post .callout-info { background: rgba(61,99,224,0.05); border-color: rgba(61,99,224,0.18); } .re-post .callout-info::before { background: var(--accent); } .re-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); } .re-post .callout-warn::before { background: var(--gold); } .re-post .callout-title { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6px; } .re-post .callout-info .callout-title { color: var(--accent); } .re-post .callout-warn .callout-title { color: var(--gold); } .re-post .callout p { margin: 0; font-size: 14px; color: var(--text2); line-height: 1.75; } .re-post .code-block { background: #1e2230; border: 1px solid rgba(120,140,200,0.15); border-radius: 12px; padding: 22px; font-family: 'JetBrains Mono', monospace; font-size: 13px; line-height: 1.8; overflow-x: auto; margin: 20px 0; position: relative; white-space: pre; color: #c8d0ea; } .re-post .code-block .kw { color: #a78bfa; } .re-post .code-block .fn { color: #34d399; } .re-post .code-block .cm { color: #525a78; font-style: italic; } .re-post .code-block .num { color: #fb923c; } .re-post .code-lang { position: absolute; top: 10px; right: 14px; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #525a78; } .re-post .brdf-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 24px 0; } @media (max-width: 640px) { .re-post .brdf-grid { grid-template-columns: 1fr; } .re-post .term-grid { grid-template-columns: 1fr; } } .re-post .brdf-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; text-align: center; } .re-post .brdf-card .icon { font-size: 26px; margin-bottom: 8px; display: block; } .re-post .brdf-card h4 { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 4px; } .re-post .brdf-card p { font-size: 12px; color: var(--text2); margin: 0; line-height: 1.55; } .re-post .summary-box { background: linear-gradient(135deg, rgba(61,99,224,0.06) 0%, rgba(114,72,212,0.06) 100%); border: 1px solid rgba(61,99,224,0.18); border-radius: 16px; padding: 36px; margin: 32px 0; text-align: center; } .re-post .summary-box h3 { font-size: 1.25rem; font-weight: 700; margin-bottom: 12px; color: var(--text); } .re-post .summary-box p { width: 100%; max-width: none; margin: 0; font-size: 15px; line-height: 1.85; color: var(--text2); text-align: left; } </style>

<div class="re-post">
<div class="eq-block">
<div class="eq-label">Kajiya's Rendering Equation (1986)</div>
<div class="eq-main"><span class="eq-term">L<sub>o</sub>(x, ω<sub>o</sub>)</span> <span class="eq-op">=</span> <span class="eq-term">L<sub>e</sub>(x, ω<sub>o</sub>)</span> <span class="eq-op">+</span> <span class="eq-int">∫</span><sub>Ω</sub> <span class="eq-fn">f<sub>r</sub></span><span class="eq-op">(x, ω<sub>i</sub>, ω<sub>o</sub>)</span> · <span class="eq-term">L<sub>i</sub>(x, ω<sub>i</sub>)</span> · <span class="eq-fn">cos θ<sub>i</sub></span> <span class="eq-op">dω<sub>i</sub></span></div>
</div>
<p style="color:var(--text2);line-height:1.85;margin-bottom:20px;"> 1986년 James Kajiya가 발표한 렌더링 방정식은 빛의 전파를 수학적으로 정의한다. 이 방정식이 실시간 엔진에서 어떻게 근사되고 구현되는지 살펴본다. </p>
<span class="section-eyebrow">00 — 그래픽스 파이프라인</span>
</div>

# 그래픽스 파이프라인 개요

<div class="re-post">
카지야 방정식을 실제로 계산하기 전에, UE5가 매 프레임 거치는 그래픽스 파이프라인 전체 흐름을 먼저 보자. 방정식의 각 항은 파이프라인의 여러 단계에 걸쳐 대체로 대응하며, 최종 픽셀 값은 각 패스의 결과를 합성해 얻어진다.
<div style="overflow-x:auto;margin:28px 0;">
<div style="display:flex;flex-direction:column;gap:0;min-width:560px;">
<div style="display:grid;grid-template-columns:180px 1fr;gap:0;border:1px solid rgba(60,80,180,0.12);border-radius:12px 12px 0 0;overflow:hidden;">
<div style="background:rgba(61,99,224,0.06);border-right:1px solid rgba(60,80,180,0.12);padding:20px 18px;">
<div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--accent);margin-bottom:6px;">CPU Stage</div>
<div style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;">InitViews</div>
<div style="font-size:12px;color:var(--text3);">Culling · 분류 · DrawCmd</div>
</div>
<div style="padding:20px 22px;display:flex;flex-direction:column;gap:6px;">
<div style="font-size:13px;font-weight:700;color:var(--text);">x 후보 결정 — 계산할 픽셀을 솎아낸다</div>
<div style="font-size:13px;color:var(--text2);">Frustum/Occlusion/Distance Culling으로 화면 밖 오브젝트 제거. View Relevance로 패스 분류. MeshPassProcessor로 셰이더(f<sub>r</sub>) 선택.</div>
<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(61,99,224,0.10);color:var(--accent);font-weight:600;">방정식 전처리</span>
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(136,144,170,0.12);color:var(--text3);font-weight:600;">L_o 계산 불필요한 x 제거</span>
</div>
</div>
</div>
<div style="display:flex;align-items:center;justify-content:center;height:28px;border-left:1px solid rgba(60,80,180,0.12);border-right:1px solid rgba(60,80,180,0.12);">
<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2v10M4 8l4 4 4-4" fill="none" stroke="#8890aa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
</div>
<div style="display:grid;grid-template-columns:180px 1fr;gap:0;border:1px solid rgba(60,80,180,0.12);border-top:none;overflow:hidden;">
<div style="background:rgba(114,72,212,0.06);border-right:1px solid rgba(60,80,180,0.12);padding:20px 18px;">
<div style="font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--accent2);margin-bottom:6px;">GPU Stage 1</div>
<div style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;">Rasterization</div>
<div style="font-size:12px;color:var(--text3);">삼각형 → 픽셀 변환</div>
</div>
<div style="padding:20px 22px;display:flex;flex-direction:column;gap:6px;">
<div style="font-size:13px;font-weight:700;color:var(--text);">x 확정 — 픽셀마다 월드 좌표·법선·UV 결정</div>
<div style="font-size:13px;color:var(--text2);">버텍스 셰이더 후 삼각형을 픽셀로 분할. 픽셀마다 보간된 월드 포지션(x), 노멀, 텍스처 좌표가 결정된다. Nanite는 이 단계를 Cluster-level 소프트웨어 래스터로 대체.</div>
<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(114,72,212,0.10);color:var(--accent2);font-weight:600;">x 확정</span>
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(136,144,170,0.12);color:var(--text3);font-weight:600;">방정식 입력값 생성</span>
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
<div style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;">Shading</div>
<div style="font-size:12px;color:var(--text3);">Base Pass · Lumen</div>
</div>
<div style="padding:20px 22px;display:flex;flex-direction:column;gap:6px;">
<div style="font-size:13px;font-weight:700;color:var(--text);">방정식 계산 — f<sub>r</sub> · L<sub>i</sub> · cosθ 적분</div>
<div style="font-size:13px;color:var(--text2);">픽셀 셰이더에서 PBR BRDF(GGX) 평가. 직접광은 해석적 계산, 간접광은 Lumen이 surface cache와 tracing으로 근사. 방정식의 핵심 항들(f<sub>r</sub>, L<sub>i</sub>, cosθ)이 주로 이 단계에서 평가되지만, 최종 결과는 Shadow, GI, Reflection 등 여러 패스의 기여가 합산된다.</div>
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
<div style="font-size:13px;font-weight:700;color:var(--text);">조명 결과 기록 — 셰이딩 결과를 render target에 쓴다</div>
<div style="font-size:13px;color:var(--text2);">Depth Test(가시성 최종 확인), Stencil Test, Alpha Blending(반투명 합산). 각 패스에서 계산된 조명 결과가 render target에 누적되고, 이후 Tone Mapping·Exposure·Post Process를 거쳐 최종 디스플레이 색으로 변환된다.</div>
<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(200,90,0,0.10);color:var(--orange);font-weight:600;">render target 기록</span>
<span style="font-size:11px;padding:2px 9px;border-radius:100px;background:rgba(136,144,170,0.12);color:var(--text3);font-weight:600;">Depth · Blend · ROP</span>
</div>
</div>
</div>
</div>
</div>
<div class="callout callout-info">
<div class="callout-title">💡 방정식과 파이프라인 대응 요약</div>
<p>InitViews는 "계산할 x를 고른다", Rasterization은 "x 좌표를 확정한다", Shading은 "방정식의 핵심 항들을 주로 평가한다", Output Merger는 "각 패스의 조명 결과를 render target에 누적한다". 방정식의 항들은 Base Pass, Shadow, GI, Reflection 등 여러 패스에 걸쳐 계산되고, 그 결과가 합산되어 최종 픽셀 색이 만들어진다.</p>
</div>
<span class="section-eyebrow">01 — 방정식 이해</span>
</div>

# 각 항이 의미하는 것

<div class="re-post">
렌더링 방정식은 "어떤 점 **x**에서 방향 ω<sub>o</sub>로 나가는 빛의 양"을 정의한다. 이 값을 알면 픽셀의 색을 결정할 수 있다.
<div class="term-grid">
<div class="term-card blue">
<div class="term-symbol">L<sub>o</sub>(x, ω<sub>o</sub>)</div>
<div class="term-name">나가는 복사 휘도 (Outgoing Radiance)</div>
<p class="term-desc">점 x에서 방향 ω<sub>o</sub>(카메라 방향)로 나가는 빛의 총량. 최종적으로 픽셀에 기록되는 값.</p>
</div>
<div class="term-card gold">
<div class="term-symbol">L<sub>e</sub>(x, ω<sub>o</sub>)</div>
<div class="term-name">방출 휘도 (Emitted Radiance)</div>
<p class="term-desc">재질 자체가 발광하는 경우 추가되는 항. 모니터, 네온사인, 불꽃 같은 발광 오브젝트가 해당.</p>
</div>
<div class="term-card teal">
<div class="term-symbol">f<sub>r</sub>(x, ω<sub>i</sub>, ω<sub>o</sub>)</div>
<div class="term-name">BRDF</div>
<p class="term-desc">양방향 반사 분포 함수. "들어온 빛 중 얼마나 반사되어 나가는가"를 결정하는 재질의 핵심.</p>
</div>
<div class="term-card coral">
<div class="term-symbol">L<sub>i</sub>(x, ω<sub>i</sub>)</div>
<div class="term-name">들어오는 복사 휘도 (Incoming Radiance)</div>
<p class="term-desc">방향 ω<sub>i</sub>에서 점 x로 들어오는 빛의 양. 이 값 자체도 재귀적으로 렌더링 방정식을 풀어야 한다.</p>
</div>
<div class="term-card purple">
<div class="term-symbol">cos θ<sub>i</sub></div>
<div class="term-name">Lambert 코사인 항</div>
<p class="term-desc">빛이 표면에 비스듬히 입사할수록 에너지가 넓게 퍼지는 물리 현상. 법선과 입사 방향의 내적.</p>
</div>
<div class="term-card orange">
<div class="term-symbol">∫<sub>Ω</sub> dω<sub>i</sub></div>
<div class="term-name">반구 적분</div>
<p class="term-desc">표면 법선을 기준으로 모든 방향에서 들어오는 빛을 다 더한다. 이 적분이 실시간 렌더링의 핵심 난제.</p>
</div>
</div>
<div class="callout callout-warn">
<div class="callout-title">⚡ 왜 어려운가</div>
<p>L<sub>i</sub>(x, ω<sub>i</sub>)를 구하려면 다시 렌더링 방정식을 풀어야 한다. 즉 빛은 재귀적으로 튕기고, 그 모든 경로를 추적하면 무한 연산이 필요하다. 실시간 엔진은 이 무한 재귀를 영리하게 <strong>근사</strong>한다.</p>
</div>
<span class="section-eyebrow">02 — UE5 렌더링 파이프라인</span>
</div>

# 언리얼 엔진5가 방정식을 푸는 방법

<div class="re-post">
UE5는 렌더링 방정식의 각 항을 서로 다른 시스템이 나누어 계산한다. 완벽한 해가 아니라 시각적으로 그럴듯한 근사치를 실시간으로 만들어내는 것이 목표다.
<div class="pipeline">
<div class="pipe-item">
<div class="pipe-num">01</div>
<div class="pipe-body">
<div class="step-badge badge-exact">Geometry Pass</div>
<h3>기하 처리 및 재질 입력 생성 — Nanite + Base Pass</h3>
<p>Nanite가 픽셀 단위 정밀도로 가시 기하를 결정하고, 이어지는 Base Pass에서 재질 셰이더가 실행되어 위치(x), 법선, BaseColor, Roughness, Metallic 등이 G-Buffer에 저장된다. Nanite는 rasterization과 visibility를 담당하고, G-Buffer 저장은 deferred base pass의 결과다. 이후 모든 조명 계산의 입력값이 여기서 만들어진다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-geo">Nanite</span>
<span class="pipe-tag tag-geo">Deferred Shading</span>
<span class="pipe-tag tag-geo">G-Buffer</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">02</div>
<div class="pipe-body">
<div class="step-badge badge-exact">Direct Light</div>
<h3>직접광 — L<sub>i</sub> × f<sub>r</sub> × cosθ 직접 계산</h3>
<p>태양, 포인트 라이트, 스팟 라이트 등 명시적 광원에서 오는 빛은 방정식을 해석적으로 적용한다. 광원 방향이 정해져 있으므로 반구 적분이 단순화된다. UE5는 Disney식 metallic/roughness 워크플로의 영향을 받은 실시간 PBR 모델을 사용하며, GGX 기반 specular BRDF와 Lambert 계열의 diffuse 근사를 조합한다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-light">Direct Lighting</span>
<span class="pipe-tag tag-light">PBR / GGX BRDF</span>
<span class="pipe-tag tag-shadow">Shadow Map</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">03</div>
<div class="pipe-body">
<div class="step-badge badge-approx">GI Approximation</div>
<h3>Lumen — 간접광 (GI) 근사</h3>
<p>방정식에서 가장 어려운 부분: 다른 표면에서 한 번 이상 튕겨온 빛. Lumen은 Surface Cache(Mesh Cards), Screen Probe Gather, Radiance Cache, Software Ray Tracing(SDF), Hardware RT fallback을 계층적으로 조합해 scene-space에서 간접광을 근사한다. 단순한 SDF 레이마칭이 아니라 여러 기법의 하이브리드 시스템이다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-gi">Lumen GI</span>
<span class="pipe-tag tag-gi">SDF Ray Marching</span>
<span class="pipe-tag tag-gi">Radiance Cache</span>
<span class="pipe-tag tag-gi">SSGI</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">04</div>
<div class="pipe-body">
<div class="step-badge badge-approx">Reflection</div>
<h3>반사 — 거울 방향 L<sub>i</sub> 추적</h3>
<p>광택 있는 표면에서의 반사는 특정 방향 ω<sub>i</sub>에 집중된 샘플링으로 근사한다. 매끈한 표면일수록 반사 방향성이 강해져 더 높은 정확도의 추적이 필요하며, Lumen은 screen trace, surface cache 조회, hardware ray tracing 등을 플랫폼·설정·hit 여부에 따라 상황에 맞게 조합해 사용한다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-gi">Lumen Reflection</span>
<span class="pipe-tag tag-gi">Screen Space Reflection</span>
<span class="pipe-tag tag-gi">Hardware RT</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">05</div>
<div class="pipe-body">
<div class="step-badge badge-approx">Shadow</div>
<h3>그림자 — 가시성 함수 V(x, ω<sub>i</sub>)</h3>
<p>빛이 점 x에 실제로 도달하는지 여부를 결정하는 가시성 함수. UE5에서는 이를 Virtual Shadow Maps, screen-space visibility, distance field 기반 occlusion, ray tracing, Lumen 내부의 tracing hit/miss 등 여러 시스템이 나누어 담당하며 상황에 따라 혼합해 사용한다. Nanite VSM은 그 중 주요한 하나로 픽셀 단위 정밀도의 그림자를 메모리 효율적으로 제공한다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-shadow">Virtual Shadow Map</span>
<span class="pipe-tag tag-shadow">Screen-space Visibility</span>
<span class="pipe-tag tag-shadow">Distance Field Occlusion</span>
<span class="pipe-tag tag-shadow">Ray Traced Shadow</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">06</div>
<div class="pipe-body">
<div class="step-badge badge-hybrid">Post Process</div>
<h3>포스트 프로세스 — 최종 L<sub>o</sub> 보정</h3>
<p>계산된 Radiance 값을 실제 디스플레이에 맞게 변환한다. Tone Mapping(HDR → LDR 변환), Exposure, Bloom(발광 오브젝트 L<sub>e</sub> 항 강조), Temporal Anti-Aliasing이 여기서 처리된다. TSR(Temporal Super Resolution)은 낮은 해상도로 렌더링 후 업스케일해 성능을 확보한다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-post">Tone Mapping</span>
<span class="pipe-tag tag-post">Bloom</span>
<span class="pipe-tag tag-post">TSR</span>
<span class="pipe-tag tag-post">TAA</span>
</div>
</div>
</div>
</div>
<span class="section-eyebrow">03 — 1:1 대응</span>
</div>

# 방정식 항 ↔ UE5 시스템 매핑

<div class="re-post">
<table class="mapping-table">
<thead>
<tr>
<th>방정식 항</th>
<th>물리적 의미</th>
<th>UE5 구현</th>
<th>방식</th>
</tr>
</thead>
<tbody>
<tr>
<td class="math-cell">L<sub>o</sub>(x, ω<sub>o</sub>)</td>
<td class="desc-cell">최종 픽셀 색</td>
<td class="ue5-cell">Final Color Buffer</td>
<td class="desc-cell">합산 결과</td>
</tr>
<tr>
<td class="math-cell">L<sub>e</sub>(x, ω<sub>o</sub>)</td>
<td class="desc-cell">재질 자체 발광</td>
<td class="ue5-cell">Emissive Channel + Bloom</td>
<td class="desc-cell">직접 추가</td>
</tr>
<tr>
<td class="math-cell">f<sub>r</sub>(x, ω<sub>i</sub>, ω<sub>o</sub>)</td>
<td class="desc-cell">BRDF (재질 반응)</td>
<td class="ue5-cell">PBR Material (GGX + Lambert)</td>
<td class="desc-cell">Disney 근사</td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (직접광)</td>
<td class="desc-cell">광원에서 직접 오는 빛</td>
<td class="ue5-cell">Directional / Point / Spot Light</td>
<td class="desc-cell">해석적 계산</td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (간접광)</td>
<td class="desc-cell">다른 표면에서 반사된 빛</td>
<td class="ue5-cell">Lumen GI (Surface Cache · Screen Probe · Radiance Cache · Tracing)</td>
<td class="desc-cell">하이브리드 근사</td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (환경광)</td>
<td class="desc-cell">Sky / IBL</td>
<td class="ue5-cell">Sky Atmosphere + SkyLight</td>
<td class="desc-cell">큐브맵 컨볼루션</td>
</tr>
<tr>
<td class="math-cell">cos θ<sub>i</sub></td>
<td class="desc-cell">Lambert 코사인 항</td>
<td class="ue5-cell">N · L (Shader 내적 연산)</td>
<td class="desc-cell">셰이더 내적 계산</td>
</tr>
<tr>
<td class="math-cell">V(x, ω<sub>i</sub>)</td>
<td class="desc-cell">가시성 (그림자)</td>
<td class="ue5-cell">VSM · DFAO · RT Occlusion 등</td>
<td class="desc-cell">복수 시스템 조합</td>
</tr>
<tr>
<td class="math-cell">∫<sub>Ω</sub> dω<sub>i</sub></td>
<td class="desc-cell">반구 적분</td>
<td class="ue5-cell">분석적 조명 · 환경맵 사전적분 · Lumen probe · 시간적 누적</td>
<td class="desc-cell">복수 기법 조합</td>
</tr>
</tbody>
</table>
<span class="section-eyebrow">04 — BRDF 상세</span>
</div>

# UE5의 PBR 재질

<div class="re-post">
UE5의 기본 재질 모델은 Disney식 metallic/roughness 워크플로의 영향을 받은 실시간 PBR 모델이다. Disney 원 논문을 그대로 구현한 것은 아니며, Epic이 SIGGRAPH 2013에서 발표한 실시간 근사를 기반으로 한다. BRDF는 Diffuse 항과 Specular 항으로 분리된다.
<div class="code-block"><div class="code-lang">HLSL (UE5 Shader)</div><span style="color:#525a78;font-style:italic">// UE5 PBR BRDF 구조 (단순화)</span>
<span class="kw">float3</span>
<span class="fn">BRDF</span>(MaterialInputs mat, <span class="kw">float3</span> L, <span class="kw">float3</span> V, <span class="kw">float3</span> N) { <span class="kw">float3</span> H = normalize(L + V); <span style="color:#525a78;font-style:italic">// Halfway vector</span>
<span class="kw">float</span> NdotL = saturate(dot(N, L)); <span style="color:#525a78;font-style:italic">// cosθ — 방정식의 cosθᵢ</span>
<span class="kw">float</span> NdotV = saturate(dot(N, V)); <span class="kw">float</span> NdotH = saturate(dot(N, H)); <span class="kw">float</span> roughness = mat.Roughness; <span style="color:#525a78;font-style:italic">// Specular BRDF: D × G × F / (4 × NdotL × NdotV)</span>
<span class="kw">float</span> D = <span class="fn">GGX_Distribution</span>(NdotH, roughness); <span style="color:#525a78;font-style:italic">// 노멀 분포 함수</span>
<span class="kw">float</span> G = <span class="fn">Smith_Schlick_GGX</span>(NdotL, NdotV, roughness); <span style="color:#525a78;font-style:italic">// 기하 감쇠</span>
<span class="kw">float3</span> F = <span class="fn">Fresnel_Schlick</span>(mat.F0, NdotV); <span style="color:#525a78;font-style:italic">// 프레넬 반사율</span>
<span class="kw">float3</span> Specular = (D * G * F) / (<span class="num">4.0</span> * NdotL * NdotV + <span class="num">0.001</span>); <span style="color:#525a78;font-style:italic">// Diffuse BRDF: Lambertian (에너지 보존 위해 Specular 뺌)</span>
<span class="kw">float3</span> kD = (<span class="num">1.0</span> - F) * (<span class="num">1.0</span> - mat.Metallic); <span class="kw">float3</span> Diffuse = kD * mat.BaseColor / PI; <span class="kw">return</span> (Diffuse + Specular) * NdotL; <span style="color:#525a78;font-style:italic">// × NdotL = cosθ 항</span> }</div>
<div class="brdf-grid">
<div class="brdf-card">
<span class="icon">🔵</span>
<h4>D — 노멀 분포 함수</h4>
<p>GGX/Trowbridge-Reitz 모델. Roughness에 따라 반사 로브의 날카로움을 결정.</p>
</div>
<div class="brdf-card">
<span class="icon">🟡</span>
<h4>G — 기하 감쇠 함수</h4>
<p>Smith's Schlick-GGX. 미세면이 서로 가리거나 반사광을 막는 효과(Shadowing/Masking).</p>
</div>
<div class="brdf-card">
<span class="icon">🟢</span>
<h4>F — 프레넬 반사율</h4>
<p>Schlick 근사. 빛이 표면에 비스듬히 입사할수록 반사율이 증가하는 프레넬 효과.</p>
</div>
</div>
<div class="callout callout-info">
<div class="callout-title">💡 Metallic/Roughness 파라미터</div>
<p>Metallic과 BaseColor가 함께 specular reflectance(F0)를 결정한다. 비금속의 경우 F0는 약 0.04로 고정되고, Metallic=1에 가까울수록 BaseColor가 specular reflectance를 직접 구성하며 diffuse 기여가 줄어든다. Roughness는 GGX 분포의 α값을 제어해 반사 로브의 날카로움을 결정한다. 이 두 파라미터로 BRDF를 실용적인 수준에서 제어한다.</p>
</div>
<span class="section-eyebrow">05 — 간접광의 핵심</span>
</div>

# Lumen이 GI를 근사하는 방법

<div class="re-post">
렌더링 방정식에서 가장 비싼 부분인 간접광(∫ L<sub>i</sub> dω<sub>i</sub>)을 Lumen은 여러 기법을 계층적으로 조합해 처리한다.
<div class="pipe-item" style="padding:0 0 20px">
<div class="pipe-num" style="background:var(--bg3)">→</div>
<div class="pipe-body">
<h3>Surface Cache &amp; Mesh Card</h3>
<p>씬의 모든 메시에 대해 Mesh Card(텍스처 형태의 표면 캐시)를 생성한다. 각 카드에는 해당 표면의 Radiance가 저장되며, 빛이 바뀌면 점진적으로 갱신된다. Screen Probe Gather가 이 Surface Cache를 scene-space에서 샘플링해 간접광을 누적한다. 인접 표면 간 다중 바운스 간접광도 이 캐시를 통해 반복적으로 근사한다.</p>
</div>
</div>
<div class="pipe-item" style="padding:0 0 20px">
<div class="pipe-num" style="background:var(--bg3)">→</div>
<div class="pipe-body">
<h3>Software Ray Marching (SDF)</h3>
<p>Signed Distance Field를 활용해 레이를 빠르게 전진시킨다. 정확한 삼각형 교차 검사 없이 "얼마나 가까운 표면이 있는가"만 확인해 레이를 진행시키므로 GPU에서 효율적으로 작동한다. 먼 거리의 GI에 주로 사용된다.</p>
</div>
</div>
<div class="pipe-item" style="padding:0 0 0">
<div class="pipe-num" style="background:var(--bg3)">→</div>
<div class="pipe-body">
<h3>Hardware Ray Tracing (선택적)</h3>
<p>DXR/Vulkan RT 지원 GPU에서는 실제 레이트레이싱으로 근거리 GI 및 반사를 계산한다. Lumen은 Software RT(원거리)와 Hardware RT(근거리)를 혼합해 품질과 성능을 동시에 달성한다.</p>
</div>
</div>
<div class="callout callout-info">
<div class="callout-title">📐 반구 적분의 실시간 근사</div>
<p>실시간 엔진은 반구 적분을 직접 계산하지 않는다. UE5는 분석적 직접광 계산, 환경맵 사전적분(IBL convolution), Screen Probe 기반 중요도 샘플링, Radiance Cache를 통한 공간 재사용, Temporal Accumulation을 통한 시간적 누적을 조합해 적분을 근사한다. 각 기법은 적분의 서로 다른 주파수 영역을 담당한다 — 저주파 영역(diffuse GI, irradiance)은 probe와 캐시로, 고주파 영역(glossy reflection, sharp visibility)은 tracing과 screen-space 기법으로 처리하는 방식이다.</p>
</div>
</div>

# 마치며

<div class="re-post">
<div class="summary-box">
<h3>렌더링 방정식은 "이상"이고, UE5는 "현실"이다</h3>
<p> 카지야의 방정식은 빛의 완벽한 물리적 거동을 기술하지만, 완전히 푸는 것은 오프라인 레이트레이싱에서도 수 시간이 걸린다. UE5는 Nanite, Lumen, VSM, TSR 등의 시스템으로 각 항을 지능적으로 근사해 초당 60프레임의 실시간 렌더링으로 구현해낸다. 이것이 "Physically Based Rendering"의 본질이다 — 물리를 흉내 내되, 영리하게. </p>
</div>
</div>
[^1]: James Kajiya, "The Rendering Equation", SIGGRAPH 1986.
[^2]: Burley, Brent. "Physically-based shading at disney." SIGGRAPH 2012.
[^3]: Epic Games, "Real Shading in Unreal Engine 4", SIGGRAPH 2013.

