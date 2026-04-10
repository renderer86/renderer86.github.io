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
- 직접광이 적분 없이 GPU에서 정확하게 계산될 수 있는 이유
- Lumen이 간접광을 어떤 기법들로 나누어 근사하는지

<br>

<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style> .re-post { --bg2: #f4f6fb; --bg3: #eef0f7; --surface: #f9fafd; --surface2: #eceef7; --border: rgba(60,80,180,0.10); --border2: rgba(60,80,180,0.22); --text: #1a1d2e; --text2: #464c6a; --text3: #8890aa; --accent: #3d63e0; --accent2: #7248d4; --gold: #b07d00; --teal: #0a8f62; --coral: #d63031; --orange: #c85a00; } .re-post .eq-block { position: relative; background: var(--bg2); border: 1px solid var(--border2); border-radius: 16px; padding: 32px 40px; margin: 24px 0 40px; overflow-x: auto; overflow-y: hidden; font-family: 'JetBrains Mono', monospace; } .re-post .eq-block::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent); } .re-post .eq-label { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--text3); margin-bottom: 16px; } .re-post .eq-main { font-size: clamp(13px, 2.5vw, 16px); color: var(--text); line-height: 2.2; white-space: nowrap; word-break: normal; min-width: max-content; } .re-post .eq-term { color: var(--accent); font-weight: 600; } .re-post .eq-op { color: var(--text3); } .re-post .eq-fn { color: var(--teal); font-weight: 600; } .re-post .eq-int { color: var(--gold); font-size: 1.3em; } .re-post .section-eyebrow { display: block; font-size: 18px; font-weight: 700; letter-spacing: 0.06em; text-transform: none; color: var(--accent); margin-bottom: 4px; margin-top: 56px; } .re-post .term-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin: 28px 0; } .re-post .term-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; position: relative; overflow: hidden; transition: border-color 0.2s, box-shadow 0.2s; } .re-post .term-card:hover { border-color: var(--border2); box-shadow: 0 2px 12px rgba(60,80,180,0.07); } .re-post .term-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; } .re-post .term-card.blue::before { background: var(--accent); } .re-post .term-card.gold::before { background: var(--gold); } .re-post .term-card.teal::before { background: var(--teal); } .re-post .term-card.coral::before { background: var(--coral); } .re-post .term-card.purple::before { background: var(--accent2); } .re-post .term-card.orange::before { background: var(--orange); } .re-post .term-symbol { font-family: 'JetBrains Mono', monospace; font-size: 17px; font-weight: 600; margin-bottom: 6px; } .re-post .term-card.blue .term-symbol { color: var(--accent); } .re-post .term-card.gold .term-symbol { color: var(--gold); } .re-post .term-card.teal .term-symbol { color: var(--teal); } .re-post .term-card.coral .term-symbol { color: var(--coral); } .re-post .term-card.purple .term-symbol { color: var(--accent2); } .re-post .term-card.orange .term-symbol { color: var(--orange); } .re-post .term-name { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 4px; } .re-post .term-desc { font-size: 13px; color: var(--text2); line-height: 1.65; margin: 0; } .re-post .pipeline { display: flex; flex-direction: column; margin: 28px 0; position: relative; } .re-post .pipeline::before { content: ''; position: absolute; left: 27px; top: 54px; bottom: 54px; width: 1px; background: linear-gradient(to bottom, var(--accent), var(--accent2)); opacity: 0.25; } .re-post .pipe-item { display: grid; grid-template-columns: 54px 1fr; gap: 18px; padding: 20px 0; position: relative; } .re-post .pipe-num { width: 54px; height: 54px; border-radius: 50%; border: 1px solid var(--border2); background: var(--surface); display: flex; align-items: center; justify-content: center; font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600; color: var(--accent); flex-shrink: 0; position: relative; z-index: 1; } .re-post .pipe-body h3 { font-size: 1rem; font-weight: 700; color: var(--text); margin-bottom: 6px; } .re-post .pipe-body p { font-size: 14px; color: var(--text2); line-height: 1.75; margin: 0; } .re-post .pipe-tag-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; } .re-post .pipe-tag { font-size: 11px; padding: 3px 10px; border-radius: 100px; font-weight: 600; letter-spacing: 0.04em; } .re-post .tag-geo { background: rgba(61,99,224,0.10); color: var(--accent); } .re-post .tag-light { background: rgba(176,125,0,0.10); color: var(--gold); } .re-post .tag-gi { background: rgba(10,143,98,0.10); color: var(--teal); } .re-post .tag-shadow { background: rgba(114,72,212,0.10); color: var(--accent2); } .re-post .tag-post { background: rgba(200,90,0,0.10); color: var(--orange); } .re-post .step-badge { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; margin-bottom: 4px; } .re-post .badge-approx { background: rgba(200,90,0,0.12); color: var(--orange); } .re-post .badge-exact { background: rgba(10,143,98,0.12); color: var(--teal); } .re-post .badge-hybrid { background: rgba(61,99,224,0.12); color: var(--accent); } .re-post .mapping-table { width: 100%; border-collapse: collapse; margin: 28px 0; font-size: 14px; } .re-post .mapping-table th { background: var(--surface2); padding: 10px 14px; text-align: left; font-weight: 700; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text3); border: 1px solid var(--border); } .re-post .mapping-table td { padding: 12px 14px; border: 1px solid var(--border); vertical-align: top; line-height: 1.6; } .re-post .mapping-table tr { background: #ffffff; } .re-post .mapping-table tr:nth-child(odd) { background: var(--surface); } .re-post .mapping-table tr:hover { background: var(--surface2); } .re-post .math-cell { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--accent); font-weight: 600; } .re-post .ue5-cell { color: var(--teal); font-weight: 600; } .re-post .desc-cell { color: var(--text2); } .re-post .callout { border-radius: 12px; padding: 18px 22px; margin: 24px 0; border: 1px solid; position: relative; overflow: hidden; } .re-post .callout::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; } .re-post .callout-info { background: rgba(61,99,224,0.05); border-color: rgba(61,99,224,0.18); } .re-post .callout-info::before { background: var(--accent); } .re-post .callout-warn { background: rgba(176,125,0,0.05); border-color: rgba(176,125,0,0.20); } .re-post .callout-warn::before { background: var(--gold); } .re-post .callout-title { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6px; } .re-post .callout-info .callout-title { color: var(--accent); } .re-post .callout-warn .callout-title { color: var(--gold); } .re-post .callout p { margin: 0; font-size: 14px; color: var(--text2); line-height: 1.75; } .re-post .code-block { background: #1e2230; border: 1px solid rgba(120,140,200,0.15); border-radius: 12px; padding: 22px; font-family: 'JetBrains Mono', monospace; font-size: 13px; line-height: 1.8; overflow-x: auto; margin: 20px 0; position: relative; white-space: pre; color: #c8d0ea; } .re-post .code-block .kw { color: #a78bfa; } .re-post .code-block .fn { color: #34d399; } .re-post .code-block .cm { color: #525a78; font-style: italic; } .re-post .code-block .num { color: #fb923c; } .re-post .code-lang { position: absolute; top: 10px; right: 14px; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #525a78; } .re-post .brdf-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 24px 0; } @media (max-width: 640px) { .re-post .brdf-grid { grid-template-columns: 1fr; } .re-post .term-grid { grid-template-columns: 1fr; } } .re-post .brdf-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; text-align: center; } .re-post .brdf-card .icon { font-size: 26px; margin-bottom: 8px; display: block; } .re-post .brdf-card h4 { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 4px; } .re-post .brdf-card p { font-size: 12px; color: var(--text2); margin: 0; line-height: 1.55; } .re-post .summary-box { background: linear-gradient(135deg, rgba(61,99,224,0.06) 0%, rgba(114,72,212,0.06) 100%); border: 1px solid rgba(61,99,224,0.18); border-radius: 16px; padding: 36px; margin: 32px 0; text-align: center; } .re-post .summary-box h3 { font-size: 1.25rem; font-weight: 700; margin-bottom: 12px; color: var(--text); } .re-post .summary-box p { width: 100%; max-width: none; margin: 0; font-size: 15px; line-height: 1.85; color: var(--text2); text-align: left; } </style>

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
<div style="font-size:13px;font-weight:700;color:var(--text);">x를 결정한다 — 방정식을 어디서 풀지 정한다</div>
<div style="font-size:13px;color:var(--text2);margin-bottom:10px;">방정식의 x는 "빛을 계산할 표면 위의 점"이다. x가 정해지지 않으면 방정식 L<sub>o</sub>(x, ω<sub>o</sub>) 자체를 세울 수 없다. InitViews는 아래 과정을 순서대로 거쳐 x 후보를 좁혀 나간다.</div>
<div style="display:flex;flex-direction:column;gap:5px;">
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent);"><span style="font-weight:700;color:var(--accent);margin-right:6px;">Frustum Culling</span>카메라의 시야각(절두체) 밖에 있는 오브젝트를 통째로 제거한다. 가장 먼저, 가장 빠르게 걸러낸다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent);"><span style="font-weight:700;color:var(--accent);margin-right:6px;">Distance Culling</span>MaxDrawDistance를 초과한 오브젝트를 제거한다. 멀어서 픽셀에 기여가 없는 x를 미리 솎아낸다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent);"><span style="font-weight:700;color:var(--accent);margin-right:6px;">Occlusion Culling (HZB)</span>이전 프레임의 Hierarchical Z-Buffer를 활용해 다른 오브젝트에 완전히 가려진 오브젝트를 제거한다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent);"><span style="font-weight:700;color:var(--accent);margin-right:6px;">Compute Relevance</span>살아남은 오브젝트가 어떤 패스(Base Pass, Shadow, Translucency 등)에 참여해야 하는지 분류한다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent);"><span style="font-weight:700;color:var(--accent);margin-right:6px;">Draw Command 생성</span>최종적으로 남은 x 후보들에 대해 GPU에 전달할 드로우 커맨드와 셰이더(f<sub>r</sub>)를 준비한다.</div>
</div>
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
<div style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px;">Base Pass</div>
<div style="font-size:12px;color:var(--text3);">래스터라이제이션 · G-Buffer</div>
</div>
<div style="padding:20px 22px;display:flex;flex-direction:column;gap:6px;">
<div style="font-size:13px;font-weight:700;color:var(--text);">삼각형을 픽셀로 쪼개고, f<sub>r</sub>·cosθ의 재료를 G-Buffer에 저장한다</div>
<div style="font-size:13px;color:var(--text2);margin-bottom:10px;">래스터라이저가 3D 삼각형을 2D 픽셀로 변환하고 UV·Normal을 보간한다. 각 픽셀에서 재질 셰이더가 실행되어 보간된 UV로 텍스처를 샘플링하고, 결과를 G-Buffer에 저장한다. 여기서 저장된 Normal(N)·Roughness·Metallic·BaseColor는 다음 Lighting Pass에서 f<sub>r</sub>와 cosθ를 계산할 재료가 된다. f<sub>r</sub> 계산 자체는 아직 일어나지 않는다.</div>
<div style="display:flex;flex-direction:column;gap:5px;">
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent2);"><span style="font-weight:700;color:var(--accent2);margin-right:6px;">하드웨어 래스터라이저 — 2×2 쿼드</span>재질 셰이더에서 <code>ddx</code>·<code>ddy</code>(UV가 인접 픽셀 사이에서 얼마나 바뀌는가)를 계산하려면 인접 픽셀이 동시에 필요하다. GPU는 이를 위해 픽셀을 2×2 묶음(쿼드)으로 실행한다. 삼각형이 1픽셀만 덮어도 나머지 3개(helper pixel)가 어쨌든 실행된다. 텍스처 밉 레벨 선택이 <code>ddx</code>·<code>ddy</code>에 의존하기 때문이다. 서브픽셀 삼각형이 많을수록 이 낭비가 커진다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--accent2);"><span style="font-weight:700;color:var(--accent2);margin-right:6px;">Nanite — Visibility Buffer 경로</span>Nanite는 Base Pass 전에 컴퓨트 셰이더로 픽셀당 triangle ID만 기록하는 Visibility Pass를 먼저 실행한다. Base Pass에서는 이 Visibility Buffer를 읽고 재질 셰이더를 픽셀당 정확히 1번만 실행한다. overdraw가 원천 차단되므로 폴리곤이 수백만 개여도 Base Pass 비용이 화면 해상도에 수렴한다. 단, 재질 셰이더는 텍스처 샘플링에 <code>ddx</code>·<code>ddy</code>가 여전히 필요하므로 2×2 쿼드로 실행된다.</div>
</div>
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
<div style="font-size:13px;color:var(--text2);margin-bottom:10px;">방정식을 실제로 푸는 단계. G-Buffer를 읽어 N·Roughness·Metallic을 가져온 뒤, 직접광과 Lumen 간접광에서 L<sub>i</sub>를 수집한다. 최종 반사광 = <strong>들어온 빛의 양(L<sub>i</sub>)</strong> × <strong>재질의 반응(f<sub>r</sub>)</strong> × <strong>입사각 보정(cosθ)</strong>. 이 셋을 곱해야 "이 방향에서 온 빛이 카메라 방향으로 얼마나 나가는가"가 된다.</div>
<div style="display:flex;flex-direction:column;gap:5px;">
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--teal);"><span style="font-weight:700;color:var(--teal);margin-right:6px;">L<sub>i</sub> — 들어오는 빛의 양</span>광원(직접광) 또는 다른 표면에서 반사되어 들어오는 빛(간접광). 이 값이 0이면 아무것도 보이지 않는다. Lumen이 간접광 L<sub>i</sub>를 근사하는 것이 가장 비용이 비싼 부분이다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--teal);"><span style="font-weight:700;color:var(--teal);margin-right:6px;">f<sub>r</sub> (BRDF) — 재질의 반응</span>"들어온 빛 중 얼마가 카메라 방향으로 반사되는가"를 정의한다. UE5의 BRDF는 두 항의 합이다.<br><br>
<span style="font-weight:600;">① Diffuse (Lambert)</span> — 빛이 표면 내부로 들어갔다 모든 방향으로 균일하게 산란되어 나온다. BaseColor에 비례하고, 보는 방향과 무관하다.<br>
<span style="font-weight:600;">② Specular (Cook-Torrance)</span> — 빛이 표면에서 반사되어 특정 방향으로 집중된다. 하이라이트와 거울 반사가 이 항에서 나온다. 내부적으로 세 함수의 곱으로 구성된다.<br>
&nbsp;&nbsp;· <span style="font-weight:600;">D (GGX)</span> — 표면의 미세면 법선이 halfway vector 방향과 얼마나 정렬되어 있는지를 분포로 나타낸다. Roughness가 낮을수록 분포가 좁아져 날카로운 하이라이트가 된다.<br>
&nbsp;&nbsp;· <span style="font-weight:600;">G (Smith-GGX)</span> — 미세면끼리 서로 가리거나(shadowing) 반사광을 막는(masking) 효과. 측면에서 볼수록 약해지는 하이라이트를 설명한다.<br>
&nbsp;&nbsp;· <span style="font-weight:600;">F (Fresnel-Schlick)</span> — 빛이 비스듬하게 입사할수록 반사율이 높아지는 물리 현상. 금속과 비금속의 반사 특성 차이도 이 항이 담당한다.</div>
<div style="font-size:12px;color:var(--text2);padding:7px 10px;background:var(--bg2);border-radius:7px;border-left:2px solid var(--teal);"><span style="font-weight:700;color:var(--teal);margin-right:6px;">cosθ — 입사각 보정</span>빛이 표면에 수직으로 입사할 때 에너지가 가장 집중되고, 비스듬할수록 같은 에너지가 넓은 면적에 퍼진다. dot(N, L)로 계산하며 이 값이 0이면 빛이 표면을 옆으로 스치는 것이므로 기여가 0이 된다.</div>
</div>
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
<p>렌더링 방정식 L<sub>o</sub> = L<sub>e</sub> + ∫ f<sub>r</sub> · L<sub>i</sub> · cosθ dω<sub>i</sub>를 파이프라인에 대응하면 — <strong>InitViews</strong>가 x를 결정하고, <strong>Base Pass</strong>가 삼각형을 픽셀로 변환하면서 f<sub>r</sub>·cosθ의 재료(N, Roughness, Metallic)를 G-Buffer에 저장하고, <strong>Lighting Pass</strong>가 G-Buffer를 읽어 L<sub>i</sub>를 모아 적분을 실제로 계산하고, <strong>Output Merger</strong>가 결과 L<sub>o</sub>를 픽셀에 기록한다. 이어지는 섹션에서 각 항의 물리적 의미를 하나씩 살펴보자.</p>
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
<p class="term-desc">양방향 반사 분포 함수. "들어온 빛 중 얼마나 반사되어 나가는가"를 결정하는 재질의 핵심. Diffuse(Lambert, 균일 산란)와 Specular(Cook-Torrance, D×G×F)의 합으로 구성된다. D(GGX)가 하이라이트 분포를, G가 미세면 shadowing을, F(Fresnel)가 입사각에 따른 반사율을 담당한다.</p>
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
<h3>기하 처리 및 재질 입력 생성 — Nanite Visibility Pass + Base Pass</h3>
<p>두 단계로 나뉜다. 먼저 <strong>Nanite Visibility Pass</strong>에서 컴퓨트 셰이더가 픽셀당 어떤 삼각형이 앞에 있는지(triangle ID)를 기록한다. 수백만 개의 서브픽셀 삼각형을 1픽셀 단위로 처리하므로 하드웨어 래스터라이저의 2×2 쿼드 낭비가 없다.</p>
<p>이어지는 <strong>Base Pass</strong>에서 재질 셰이더가 실행된다. non-Nanite 메시는 하드웨어 래스터라이저 → 픽셀 셰이더 순으로, Nanite 메시는 Visibility Buffer를 읽고 재질 셰이더를 실행한다. 텍스처 샘플링 시 ddx·ddy(밉 레벨 결정)가 필요하므로 재질 셰이더는 여전히 2×2 쿼드로 실행된다. Nanite의 경우 overdraw가 원천 차단되어 폴리곤 수와 무관하게 Base Pass 비용이 화면 해상도에 수렴한다. 최종적으로 N, Roughness, Metallic, BaseColor가 G-Buffer에 저장되어 이후 모든 조명 계산의 입력이 된다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-geo">Nanite Visibility Pass</span>
<span class="pipe-tag tag-geo">Base Pass</span>
<span class="pipe-tag tag-geo">G-Buffer</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">02</div>
<div class="pipe-body">
<div class="step-badge badge-exact">Direct Light</div>
<h3>직접광 — G-Buffer를 읽어 L<sub>i</sub> × f<sub>r</sub> × cosθ 해석적 계산</h3>
<p>Lighting Pass에서 G-Buffer를 읽어 N·Roughness·Metallic을 가져온다. 태양, 포인트 라이트, 스팟 라이트 등 명시적 광원은 입사 방향 ω<sub>i</sub>가 하나로 고정되어 있으므로 반구 전체를 적분할 필요 없이 해당 방향만 계산하면 된다. 간접광과 달리 "어느 방향에서 빛이 올지"가 이미 정해져 있기 때문에 연속 적분(∫)이 광원 수만큼의 합산(Σ)으로 바뀐다. 이는 GPU에서 곱셈·덧셈으로 정확하게 계산할 수 있다. 각 광원에 대해 L<sub>i</sub>(광원 강도) × f<sub>r</sub>(GGX BRDF) × cosθ = dot(N, L)를 계산하고 합산한다.</p>
<p>f<sub>r</sub>는 Diffuse(Lambert, 균일 산란)와 Specular(Cook-Torrance, D×G×F)의 합이다. D(GGX)는 Roughness에 따라 하이라이트 크기를, G(Smith-GGX)는 미세면 shadowing/masking을, F(Fresnel-Schlick)는 입사각에 따른 반사율 변화를 담당한다. 근사 없이 방정식을 완전하게 계산하는 유일한 항목이다.</p>
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
<h3>Lumen — 간접광 L<sub>i</sub>(다른 표면에서 반사된 빛) 근사</h3>
<p>렌더링 방정식에서 가장 어려운 항: 직접광이 다른 표면에 닿고 거기서 다시 반사되어 들어오는 L<sub>i</sub>. 이를 정확히 계산하려면 무한히 재귀적인 추적이 필요하다. Lumen은 다음 기법들을 계층적으로 조합해 근사한다.</p>
<p><strong>Surface Cache (Mesh Cards)</strong> — 씬의 각 메시 표면에 Radiance를 텍스처(카드) 형태로 캐시한다. 빛이 변하면 점진적으로 갱신되며, 다중 바운스 간접광을 누적하는 기반이 된다.<br>
<strong>Screen Probe Gather</strong> — 화면에 일정 간격으로 probe를 배치하고, 각 probe에서 Surface Cache를 scene-space로 샘플링해 irradiance를 수집한다. 화면 공간 픽셀의 간접광 입력이 된다.<br>
<strong>Radiance Cache</strong> — 월드 공간에 sparse 구조로 배치된 저주파 캐시. 원거리 간접광처럼 Screen Probe가 커버하지 못하는 영역을 보완한다.<br>
<strong>SDF Ray Marching</strong> — Signed Distance Field를 이용해 삼각형 교차 검사 없이 레이를 빠르게 전진시킨다. Surface Cache hit 확인 및 원거리 occlusion에 주로 사용된다.<br>
<strong>Hardware RT (선택적)</strong> — DXR/Vulkan RT 지원 GPU에서 근거리 레이트레이싱으로 정밀도를 높인다. Software RT와 혼합 사용한다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-gi">Lumen GI</span>
<span class="pipe-tag tag-gi">Surface Cache</span>
<span class="pipe-tag tag-gi">Screen Probe</span>
<span class="pipe-tag tag-gi">Radiance Cache</span>
<span class="pipe-tag tag-gi">SDF</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">04</div>
<div class="pipe-body">
<div class="step-badge badge-approx">Reflection</div>
<h3>반사 — Roughness가 낮을수록 집중된 방향의 L<sub>i</sub>가 필요하다</h3>
<p>BRDF의 D(GGX) 항은 Roughness가 낮을수록 specular lobe가 좁아진다. 즉 거울에 가까운 표면일수록 반사 방향 ω<sub>r</sub> 근방의 L<sub>i</sub>가 집중적으로 필요하다. GI 근사만으로는 이 방향의 L<sub>i</sub>를 충분한 해상도로 얻을 수 없어 별도의 추적이 필요하다.</p>
<p>Lumen Reflection은 다음 순서로 시도한다. ① <strong>Screen Space Trace</strong> — 반사 방향으로 화면 공간 레이를 쏴 히트가 있으면 가장 저렴하게 해결한다. ② <strong>Surface Cache 조회</strong> — 화면 밖이거나 히트 없으면 Surface Cache에서 해당 방향의 Radiance를 읽는다. ③ <strong>Hardware RT</strong> — 지원되는 GPU에서는 실제 레이트레이싱으로 근거리 반사를 정밀 계산한다. Roughness가 높아질수록 lobe가 넓어져 GI와 반사의 경계가 흐려지고 별도 추적의 필요성이 줄어든다.</p>
<div class="pipe-tag-row">
<span class="pipe-tag tag-gi">Lumen Reflection</span>
<span class="pipe-tag tag-gi">Screen Space Trace</span>
<span class="pipe-tag tag-gi">Surface Cache</span>
<span class="pipe-tag tag-gi">Hardware RT</span>
</div>
</div>
</div>
<div class="pipe-item">
<div class="pipe-num">05</div>
<div class="pipe-body">
<div class="step-badge badge-approx">Shadow</div>
<h3>그림자 — 빛이 점 x에 실제로 도달하는가</h3>
<p>직접광 계산에서 L<sub>i</sub>를 더하기 전에 빛이 x까지 실제로 도달하는지 확인해야 한다. 차단된 경우 L<sub>i</sub> = 0으로 처리한다. UE5는 여러 시스템을 조합해 이를 담당한다.</p>
<p><strong>Virtual Shadow Maps (VSM)</strong> — 전통적인 Shadow Map은 넓은 씬을 고해상도로 커버하기 어렵다. VSM은 가상 텍스처링 방식으로 필요한 영역만 고해상도로 생성한다. Nanite 메시도 VSM에 렌더링되어 픽셀 단위 정밀도의 그림자를 제공한다. <strong>Distance Field Occlusion</strong> — 원거리 ambient occlusion에 SDF를 활용한다. <strong>Ray Traced Shadow</strong> — 지원 시 레이트레이싱으로 정밀한 소프트 쉐도우를 계산한다.</p>
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
<h3>포스트 프로세스 — 최종 L<sub>o</sub> 보정 및 디스플레이 변환</h3>
<p>계산된 HDR Radiance 값을 실제 디스플레이에 맞게 변환한다. <strong>Tone Mapping</strong>은 HDR의 L<sub>o</sub>를 디스플레이가 표현할 수 있는 LDR 색상으로 압축한다. <strong>Exposure</strong>는 카메라 노출값을 시뮬레이션한다. <strong>Bloom</strong>은 매우 밝은 영역이 카메라 렌즈에서 인접 픽셀로 번지는 광학 효과로, 발광 오브젝트뿐 아니라 임계값 이상의 모든 밝은 영역에 적용된다. <strong>TSR(Temporal Super Resolution)</strong>은 낮은 해상도로 렌더링한 뒤 이전 프레임 데이터를 활용해 고해상도로 업스케일해 성능을 확보한다.</p>
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
<td class="ue5-cell">Emissive Channel</td>
<td class="desc-cell">직접 추가</td>
</tr>
<tr>
<td class="math-cell">f<sub>r</sub>(x, ω<sub>i</sub>, ω<sub>o</sub>)</td>
<td class="desc-cell">BRDF (재질 반응)</td>
<td class="ue5-cell">PBR Material (GGX Specular + Lambert Diffuse)</td>
<td class="desc-cell">Epic SIGGRAPH 2013 실시간 근사</td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (직접광)</td>
<td class="desc-cell">광원에서 직접 오는 빛</td>
<td class="ue5-cell">Directional / Point / Spot Light</td>
<td class="desc-cell">ω<sub>i</sub> 고정 → ∫ 불필요, 광원 수만큼 Σ 합산</td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (간접광)</td>
<td class="desc-cell">다른 표면에서 반사된 빛</td>
<td class="ue5-cell">Lumen GI (Surface Cache · Screen Probe · Radiance Cache · SDF · HW RT)</td>
<td class="desc-cell">하이브리드 근사</td>
</tr>
<tr>
<td class="math-cell">L<sub>i</sub> (반사)</td>
<td class="desc-cell">specular lobe 방향의 집중된 빛</td>
<td class="ue5-cell">Lumen Reflection (Screen Trace → Surface Cache → HW RT)</td>
<td class="desc-cell">Roughness 낮을수록 lobe 좁아져 별도 추적 필요</td>
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
<td class="ue5-cell">VSM · DFAO · RT Shadow 등</td>
<td class="desc-cell">복수 시스템 조합</td>
</tr>
<tr>
<td class="math-cell">∫<sub>Ω</sub> dω<sub>i</sub></td>
<td class="desc-cell">반구 적분</td>
<td class="ue5-cell">직접광 → Σ 합산 / 간접광 → Lumen probe · 환경맵 사전적분 · 시간적 누적</td>
<td class="desc-cell">직접광은 ∫ 불필요, 간접광은 복수 기법 근사</td>
</tr>
</tbody>
</table>
</div>

# 마치며

<div class="re-post">
<div class="summary-box">
<h3>렌더링 방정식은 "이상"이고, UE5는 "현실"이다</h3>
<p> 카지야의 방정식은 빛의 완벽한 물리적 거동을 기술하지만, 완전히 푸는 것은 오프라인 레이트레이싱에서도 수 시간이 걸린다. UE5는 Nanite, Lumen, VSM, TSR 등의 시스템으로 각 항을 지능적으로 근사해 초당 60프레임의 실시간 렌더링으로 구현해낸다. 이것이 "Physically Based Rendering"의 본질이다 — 물리를 흉내 내되, 영리하게. </p>
</div>
</div>
[^1]: James Kajiya, "The Rendering Equation", SIGGRAPH 1986.
[^2]: Epic Games, "Real Shading in Unreal Engine 4", SIGGRAPH 2013.

