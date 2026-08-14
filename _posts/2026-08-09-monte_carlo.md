---
layout: post
title: "몬테카를로 적분과 임포턴스 샘플링: 렌더링 노이즈가 생기는 이유부터 균등 난수 두 개가 GGX 방향이 되기까지"
icon: paper
permalink: monte-carlo
categories: Rendering
tags: [ComputerGraphics, Rendering, MonteCarlo, ImportanceSampling, PathTracing, MIS, UnrealEngine]
excerpt: "Lumen을 켜고 어두운 실내를 보면 화면이 미세하게 끓고, 패스 트레이서는 자글자글한 그림에서 시작해 시간이 지나야 매끈해진다. 이 노이즈는 버그가 아니라 렌더러가 적분을 푸는 방식 그 자체다. 렌더링 방정식의 적분은 닫힌 식으로 풀 수 없어서, 렌더러는 무작위 방향으로 ray를 쏘고 결과를 평균낸다. 이 글은 그 방법이 왜 수학적으로 정당한지에서 출발해, 균등 난수 두 개를 원하는 분포의 방향으로 바꾸는 inverse CDF, 중요한 방향을 더 자주 뽑고 그만큼 나눠서 보정하는 임포턴스 샘플링, 언리얼엔진 5.8의 MonteCarlo.ush가 방향과 PDF를 float4 하나로 묶어 반환하는 관례까지 순서대로 짚는다. 이어서 어떤 난수를 쓰는지(Sobol, 블루노이즈, Halton의 역할 분담), 라이트를 직접 겨냥하는 NEE, 두 샘플링 전략을 섞는 MIS, 경로를 확률적으로 끊는 러시안 룰렛을 패스 트레이서 소스로 확인하고, 마지막으로 리플렉션 프리필터·SSR·Lumen·MegaLights가 같은 수학을 각자의 예산에 맞게 변형해 쓰는 모습을 정리한다."
back_color: "#ffffff"
img_name: "monte-carlo-core-sketch.webp"
toc: false
show: true
new: true
series: -1
index: 37
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 레이트레이싱이나 Lumen 화면에 끼는 노이즈가 어디서 오는지, 왜 샘플을 늘리면 줄어드는지 원리부터 알고 싶은 분
> - 셰이더에서 `ImportanceSampleGGX(E, a2)` 같은 함수를 만날 때마다 E가 뭐고 반환값의 w가 뭔지 넘겨짚고 지나갔던 분
> - "중요한 곳을 더 자주 샘플링한다"는 말이 왜 결과를 왜곡하지 않는지, 그 보정의 수학을 확인하고 싶은 분
> - NEE, MIS, 러시안 룰렛 같은 용어를 코드 실물과 함께 정리하고 싶은 분
> - Lightmass, ReSTIR, 디노이징 글을 읽다가 "몬테카를로부터 다시"가 필요해진 분
>
> **이 글로 알 수 있는 내용**
>
> - 렌더링 방정식의 적분을 해석적으로 못 푸는 이유와, 격자식 수치적분이 차원 앞에서 무너지는 이유
> - 몬테카를로 추정량 (1/N)Σ f/p(샘플이 가져온 값 f를 그 샘플이 뽑힐 확률밀도 p로 나눠 평균)가 정답에 수렴하는 근거와, 오차가 1/√N이라는 것의 실전 의미(샘플 4배 = 노이즈 절반)
> - 균등 난수를 원하는 분포로 바꾸는 inverse CDF, 그리고 UE 5.8 `MonteCarlo.ush`의 `float4(방향, PDF)` 반환 관례
> - 임포턴스 샘플링이 분산을 줄이는 원리: Lambert에서는 항이 통째로 소거되고, GGX에서는 NDF 샘플링과 VNDF 샘플링이 갈린다
> - UE 5.8이 자리마다 다른 난수를 쓰는 이유: 패스 트레이서의 Owen-scrambled Sobol, 실시간의 블루노이즈, TAA 지터의 Halton
> - 패스 트레이서의 세 기둥: 라이트를 직접 겨냥하는 NEE, 두 전략을 섞는 MIS(파워 휴리스틱), 결과를 어둡게 왜곡하지 않으면서 경로를 끊는 러시안 룰렛
> - 파이어플라이가 생기는 수학적 이유와, 엔진 도처의 꼬리 자르기(`E.y *= 0.995`, `MaxPathIntensity`)가 지불하는 대가
> - 리플렉션 프리필터·SSR·Lumen 스크린 프로브·MegaLights가 "균등 난수 → 워프 → 기여/PDF"라는 같은 3단 패턴의 변주라는 것
>
<br>

{% include research-post-style.html %}

<div class="research-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 노이즈는 버그가 아니라 계산 방식이다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
Lumen을 켜고 어두운 실내를 바라보면 화면이 미세하게 끓는다. 패스 트레이서로 렌더를 시작하면 첫 프레임은 자글자글한 점 그림이고, 몇 초를 기다려야 매끈해진다. 레이트레이싱 그림자도 디노이저를 끄면 경계가 지글거린다. 서로 다른 기능인데 노이즈의 생김새가 닮았다. 우연이 아니다. 셋 다 같은 방법으로 적분을 풀고 있고, 그 방법의 이름이 몬테카를로 적분이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<a href="/d8c73243c492ed7b5f44b70936cfe4521669ad34">렌더링 방정식 글</a>에서 픽셀 하나의 색은 "반구의 모든 방향에서 들어오는 빛을 재질의 반응(<a href="/brdf">BRDF</a>)으로 가중해 전부 더한 것"이라고 정리했다. 그 "전부 더한다"가 적분이다. 문제는 이 적분을 공식으로 풀 수 없다는 것이다. 그래서 렌더러는 방향 몇 개를 무작위로 뽑아 ray를 쏘고, 돌아온 값들을 평균낸다. 놀랍게도 이 평균은 진짜 적분값으로 수렴한다는 것이 수학적으로 보장되고, 수렴하기 전까지의 오차가 화면에는 노이즈로 보인다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 글은 그 도구 하나를 끝까지 파고든다. 왜 적분을 못 푸는지(01장), 찍어서 평균내는 것이 왜 정당한지(02장), GPU가 주는 균등 난수를 원하는 방향 분포로 바꾸는 법(03장), 중요한 방향을 더 자주 뽑고도 결과가 왜곡되지 않게 보정하는 임포턴스 샘플링(04장, 05장), 어떤 난수를 쓰는지(06장), 그리고 라이트를 직접 겨냥하는 기법과 두 전략을 섞는 기법, 경로를 왜곡 없이 끊는 기법(07~09장)까지. 각 단계마다 언리얼엔진 5.8 소스의 실물 코드를 확인한다. 이 블로그의 <a href="/gpu-lightmass">GPU Lightmass</a>, <a href="/restir">ReSTIR</a>, <a href="/denoising">디노이징</a>, <a href="/raytracing-gi">Ray Traced GI</a> 글이 전부 이 글의 내용을 전제로 깔고 있었다. 이번에 그 바닥을 채운다.
</p>

<div class="callout callout-info">
<div class="callout-title">이름의 유래</div>
<p>몬테카를로는 모나코의 카지노 지구 이름이다. 1940년대 맨해튼 프로젝트에서 중성자가 물질 속을 퍼져 나가는 문제를 풀던 스타니스와프 울람과 존 폰 노이만이, 수식으로 못 푸는 계산을 "주사위를 굴려서" 푸는 이 방법에 카지노의 이름을 붙였다. 빛이 장면 속을 퍼져 나가는 문제는 중성자 수송과 수학적으로 같은 문제라서, 40년 뒤 Kajiya가 렌더링 방정식(1986)을 세울 때 풀이법도 그대로 가져왔다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">01 — 문제</span>
</div>

# 왜 적분을 공식으로 못 푸는가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
픽셀 하나의 밝기를 구하려면 표면 위 한 점에서 반구의 모든 입사 방향에 대해 (들어오는 빛 × BRDF × 코사인)을 더해야 한다. 프로그래머의 첫 반응은 이럴 것이다. "for 루프로 방향을 잘게 나눠서 다 더하면 되잖아?" 반구를 위도 32칸 × 경도 32칸으로 나누고 칸마다 ray를 쏘면 1024번의 덧셈으로 꽤 정확한 값이 나온다. 이렇게 격자를 정해 놓고 더하는 방식을 구적(quadrature)이라고 부른다. 실제로 1차원 적분에서는 이 방식이 몬테카를로보다 훨씬 빠르고 정확하다.
</p>

<p style="color:var(--text2);line-height:1.85;">
렌더링에서 이 방식이 무너지는 이유는 두 가지다. 첫째, <strong>피적분 함수의 식을 모른다.</strong> 방향 ω에서 들어오는 빛 L<sub>i</sub>(x, ω)는 그 방향에 있는 다른 표면이 내보내는 빛이다. 값을 알려면 그쪽으로 ray를 쏴서 맞은 표면의 밝기를 구해야 하는데, 그 표면의 밝기가 또 같은 적분이다. 코드로 치면 피적분 함수가 수식이 아니라 <strong>호출해야만 값을 주는 재귀 콜백</strong>이다. 식이 없으니 해석적 적분(공식으로 풀기)은 애초에 선택지가 아니다.
</p>

<p style="color:var(--text2);line-height:1.85;">
둘째, <strong>재귀 때문에 차원이 폭발한다.</strong> 한 번의 반사만 보면 방향 2차원(위도, 경도) 적분이다. 그런데 빛이 두 번 튀는 경로까지 보면 첫 표면에서의 방향 2차원 × 둘째 표면에서의 방향 2차원으로 4차원이 되고, 바운스마다 2차원씩 늘어난다. 여기에 안티에일리어싱용 픽셀 내 위치 2차원, 렌즈(DOF) 2차원까지 더하면 픽셀 하나의 값은 10차원이 넘는 공간의 적분이다. 격자 방식으로 차원마다 겨우 10칸씩만 나눠도 10차원이면 10<sup>10</sup>개, 즉 100억 개의 칸이 필요하다. 이렇게 격자 구적의 비용이 차원에 지수적으로 불어나는 현상을 수치해석에서는 차원의 저주(curse of dimensionality)라고 부른다.
</p>

<div class="callout callout-warn">
<div class="callout-title">구적 vs 몬테카를로: 수렴 속도의 교환</div>
<p>1차원에서 격자 구적(사다리꼴 공식)의 오차는 칸 수 N에 대해 1/N²으로 준다. 몬테카를로는 1/√N으로 줄어서 훨씬 느리다. 그런데 구적의 수렴률은 차원이 d가 되면 1/N<sup>2/d</sup>로 나빠지는 반면, <strong>몬테카를로의 1/√N은 차원과 무관하다.</strong> 무작위 지점의 평균이라는 방법 자체가 "공간을 칸으로 덮는다"는 개념이 없기 때문이다. 4차원쯤에서 손익이 뒤집히고, 10차원이 넘는 렌더링에서는 몬테카를로가 사실상 유일한 선택지다. 대신 그 대가로 오차가 규칙적 편차가 아니라 무작위 노이즈로 나타난다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">02 — 추정량</span>
</div>

# 찍어서 평균내기: (1/N) Σ f/p

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
몬테카를로 적분의 아이디어는 여론조사와 같다. 전 국민의 평균 의견을 알고 싶으면 전원에게 묻는 대신 1000명을 무작위로 뽑아 평균낸다. 표본 평균은 진짜 평균과 정확히 같지는 않지만, 표본을 늘릴수록 다가가고, 얼마나 벗어나 있을지의 범위도 통계적으로 안다. 적분도 똑같이 한다. 적분이란 결국 "함수값의 (가중) 총합"이므로, 무작위 지점 몇 곳의 함수값으로 전체를 추정할 수 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
일반형은 이렇다. <strong>적분하고 싶은 함수가 f</strong>다. 렌더링에서는 "그 방향에서 들어온 빛 × BRDF × 코사인", 즉 ray 하나가 물어오는 값이 f다. 그리고 <strong>지점 X를 뽑을 때 쓴 확률밀도</strong><span class="fn-note"><input type="checkbox" id="fn-pdf" class="fn-toggle"><label for="fn-pdf" class="fn-ref">1</label><span class="fn-body"><strong>확률밀도함수(PDF, probability density function):</strong> 연속 공간에서 "이 지점이 뽑힐 확률"을 말할 때 쓰는 함수. 주사위 같은 이산 확률과 달리 연속 공간에서는 정확히 한 점이 뽑힐 확률이 0이라서, 대신 "구간을 히스토그램 버킷으로 잘게 쪼갰을 때 그 버킷에 들어올 확률 ÷ 버킷 크기"의 극한으로 정의한다. 값이 클수록 그 근처가 자주 뽑힌다는 뜻이고, 전 구간에서 적분하면 1이다. 방향의 PDF는 "단위 입체각당 확률"이라 단위가 1/sr이다.</span></span>가 p다. X를 이 p를 따라 무작위로 뽑는다면, 다음 값이 적분의 추정량(estimator, 정답 대신 쓰는 통계적 근사값)이 된다.
</p>

<div class="eq-anno-wrap">
<div class="formula-label">Monte Carlo Estimator</div>
<div class="eq-anno">
<span class="term">
<span class="t-formula"><i>F̂</i><sub>N</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 26 2, 52 5 T 97 4" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">적분의 추정값<br>= 픽셀에 쓰는 값</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><span class="frac"><span class="fr-t">1</span><span class="fr-b">N</span></span> <span style="font-size:1.3em;">Σ</span><sub>i=1..N</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4 Q 30 6.5, 55 3.5 T 97 5" fill="none" stroke="#3d63e0" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#3d63e0;">N개 샘플의 평균</span>
</span>
<span class="term">
<span class="t-formula"><span class="frac"><span class="fr-t"><i>f</i>(<i>X</i><sub>i</sub>)</span><span class="fr-b"><i>p</i>(<i>X</i><sub>i</sub>)</span></span></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5 Q 28 2.5, 54 5.5 T 97 3.5" fill="none" stroke="#0a8f72" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#0a8f72;">ray가 가져온 값을<br>그 방향이 뽑힐 확률밀도로 나눔</span>
</span>
</div>
<div class="formula-note">X<sub>i</sub>는 PDF p를 따라 뽑은 무작위 지점. p로 나누는 것이 이 글 전체의 핵심 한 수다.</div>
</div>

<div class="callout callout-info">
<div class="callout-title">이 글의 두 기호: f와 p</div>
<p>이 두 글자는 글이 끝날 때까지 계속 나오므로 여기서 못을 박아 두자. <strong>f는 장면이 정하는 값이다.</strong> 어느 방향으로 ray를 쏘면 얼마짜리 빛이 돌아오는지는 장면과 재질이 이미 정해 놓았고, 우리는 바꿀 수 없다. <strong>p는 우리가 정하는 값이다.</strong> 어떤 방향을 얼마나 자주 뽑을지는 샘플링 코드를 어떻게 짜느냐에 달린 우리의 선택이고, 04장부터 나오는 모든 기법은 결국 "p를 어떻게 고르느냐"의 이야기다. 몬테카를로 렌더링 전체를 한 문장으로 줄이면 이렇다. <strong>장면이 준 f를, 우리가 고른 p로 뽑고, f/p로 보정해 평균낸다.</strong></p>
</div>

<p style="color:var(--text2);line-height:1.85;">
왜 p로 나누는가. 여론조사 비유를 이어가면, 표본에 20대가 실제 인구 비율보다 두 배 많이 뽑혔다면 조사기관은 20대 응답의 가중치를 절반으로 줄여서 보정한다. 정확히 같은 보정이다. <strong>자주 뽑히는 지점(p가 큰 곳)의 값은 합계에 여러 번 등장할 테니, 미리 그만큼 나눠서 목소리를 줄여 둔다.</strong> 이 보정 덕분에 뽑는 분포 p를 무엇으로 고르든(빛이 오는, 즉 f가 0이 아닌 방향을 뽑을 확률이 0만 아니면) 추정량의 기대값이 진짜 적분값과 정확히 일치한다. 이 성질을 불편(unbiased)이라고 부른다. 평균을 계속 내면 반드시 정답으로 수렴한다는 뜻이고, 나중에 p를 우리 마음대로 고를 자유(04장)의 근거가 된다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 310" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="무작위 지점의 함수값 평균이 적분값으로 수렴하는 과정">
<rect x="10" y="10" width="740" height="290" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">① 무작위 지점에서 f를 읽는다</text>
<path d="M50 235 C 100 225, 130 150, 180 165 C 220 177, 240 90, 290 82 C 330 76, 370 150, 400 170 L400 250 L50 250 Z" fill="#3b82c4" opacity="0.12"/>
<path d="M50 235 C 100 225, 130 150, 180 165 C 220 177, 240 90, 290 82 C 330 76, 370 150, 400 170" fill="none" stroke="#3b82c4" stroke-width="2.5"/>
<text x="215" y="215" font-family="Segoe UI, sans-serif" font-size="12" fill="#3b82c4" font-weight="700">구하려는 것 = 이 면적</text>
<g stroke="#9aa3b5" stroke-width="1" stroke-dasharray="4 4">
<line x1="90" y1="250" x2="90" y2="218"/><line x1="150" y1="250" x2="150" y2="172"/><line x1="210" y1="250" x2="210" y2="155"/><line x1="265" y1="250" x2="265" y2="95"/><line x1="320" y1="250" x2="320" y2="92"/><line x1="375" y1="250" x2="375" y2="150"/>
</g>
<g fill="#b45309">
<circle cx="90" cy="250" r="3.5"/><circle cx="150" cy="250" r="3.5"/><circle cx="210" cy="250" r="3.5"/><circle cx="265" cy="250" r="3.5"/><circle cx="320" cy="250" r="3.5"/><circle cx="375" cy="250" r="3.5"/>
</g>
<g fill="#0a8f72">
<circle cx="90" cy="218" r="4"/><circle cx="150" cy="172" r="4"/><circle cx="210" cy="155" r="4"/><circle cx="265" cy="95" r="4"/><circle cx="320" cy="92" r="4"/><circle cx="375" cy="150" r="4"/>
</g>
<line x1="50" y1="250" x2="400" y2="250" stroke="#4b5563" stroke-width="1.5"/>
<text x="60" y="272" font-family="Segoe UI, sans-serif" font-size="12" fill="#b45309">무작위로 뽑은 지점 X</text>
<text x="280" y="72" font-family="Segoe UI, sans-serif" font-size="12" fill="#0a8f72" font-weight="700">읽은 값 f(X)</text>
<text x="440" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">② 평균이 정답으로 수렴한다</text>
<path d="M455 70 C 520 110, 600 132, 720 141 L720 161 C 600 172, 520 192, 455 232 Z" fill="#b45309" opacity="0.10"/>
<line x1="450" y1="151" x2="720" y2="151" stroke="#0a8f72" stroke-width="1.5" stroke-dasharray="6 4"/>
<text x="590" y="143" font-family="Segoe UI, sans-serif" font-size="12" fill="#0a8f72" font-weight="700">진짜 적분값</text>
<path d="M455 95 L470 195 L490 120 L510 185 L535 133 L560 172 L590 142 L620 162 L650 147 L680 156 L718 152" fill="none" stroke="#b45309" stroke-width="2"/>
<text x="470" y="238" font-family="Segoe UI, sans-serif" font-size="12" fill="#b45309">지금까지의 평균 (1/N)Σ f/p</text>
<line x1="450" y1="265" x2="720" y2="265" stroke="#4b5563" stroke-width="1.5"/>
<text x="555" y="285" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">샘플 수 N →</text>
<text x="455" y="62" font-family="Segoe UI, sans-serif" font-size="12" fill="#b45309">오차 범위 ∝ 1/√N</text>
</svg>
<div class="scene-cap">적분은 곡선 아래 면적이다. 무작위 지점 몇 곳에서 f를 읽어 f/p로 보정해 평균내면(왼쪽), 그 평균은 샘플이 쌓일수록 진짜 면적으로 수렴한다(오른쪽). 수렴 전의 흔들리는 폭이 화면에서는 노이즈로 보이고, 폭을 절반으로 줄이려면 샘플이 4배 필요하다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
"평균을 계속 내면 수렴한다"가 코드에서는 어떻게 생겼을까. UE 패스 트레이서는 프레임마다 픽셀당 경로 1개(1 SPP<span class="fn-note"><input type="checkbox" id="fn-spp" class="fn-toggle"><label for="fn-spp" class="fn-ref">2</label><span class="fn-body"><strong>SPP(samples per pixel):</strong> 픽셀당 샘플(경로) 수. 패스 트레이서의 품질 단위로, UE에서는 <code>r.PathTracing.SamplesPerPixel</code> 또는 포스트 프로세스 볼륨 설정으로 정한다. 실시간 기법들은 대개 1 SPP로 쏘고 나머지를 시간축 누적과 디노이저에 맡긴다.</span></span>)를 진행하면서 결과 텍스처에 러닝 평균으로 블렌드한다. 정답에 다가가는 코드는 lerp 한 줄이다.
</p>

<div class="code-block"><span class="code-lang">HLSL — PathTracingCore.ush · C++ — PathTracing.cpp (UE 5.8)</span><span class="cm">// 경로 하나가 끝나면 러닝 평균으로 블렌드</span>
<span class="kw">void</span> <span class="fn">WritePixel</span>(<span class="ty">uint2</span> TextureIndex)
{
	<span class="ty">float4</span> OldPixel = Iteration > <span class="num">0</span> ? RadianceTexture[TextureIndex] : <span class="num">0</span>;
	RadianceTexture[TextureIndex] = <span class="fn">lerp</span>(OldPixel, PixelValue, BlendFactor);
}

<span class="cm">// C++ 쪽: BlendFactor = 1/(N+1). lerp(OldMean, X_N, 1/(N+1))은 N+1개 샘플의 산술평균과 동치다</span>
Config.PathTracingData.Iteration = PathTracingState->SampleIndex;
Config.PathTracingData.BlendFactor = <span class="num">1.0f</span> / (Config.PathTracingData.Iteration + <span class="num">1</span>);</div>

<p style="color:var(--text2);line-height:1.85;">
남는 질문은 수렴 속도다. 추정량은 뽑기 운에 따라 매번 값이 달라지는 확률변수라서 N개 평균의 표준편차(들쭉날쭉한 정도)가 있는데, 이것이 <strong>1/√N에 비례해서 준다.</strong> 화면에서 이 표준편차가 곧 노이즈의 강도다. 이 "들쭉날쭉한 정도"를 통계 용어로 분산(variance)이라고 부르고, 이 글에서 앞으로 분산이라고 하면 전부 "화면 노이즈의 세기"로 읽으면 된다. 실전 감각으로 외워둘 규칙도 여기서 나온다. <strong>샘플을 4배로 늘려야 노이즈가 절반이 된다.</strong> 16 SPP 그림의 노이즈를 다시 절반으로 줄이려면 64 SPP가 필요하다. 샘플 수로 노이즈를 잡는 것은 이렇게 비싸기 때문에, 렌더링 연구의 대부분은 "N을 늘리지 않고 분산 자체를 줄이는 법"이고, 그 첫 번째 도구가 임포턴스 샘플링이다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">03 — 분포 뒤집기</span>
</div>

# 균등 난수 두 개를 방향으로 바꾸는 법

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
추정량을 쓰려면 "PDF p를 따라 지점을 뽑는" 코드가 필요하다. 그런데 GPU에서 우리가 손에 쥘 수 있는 것은 [0,1) 구간의 균등 난수뿐이다. 균등 난수 두 개(관례상 <code>float2 E</code>)를 원하는 분포의 방향으로 바꾸는 변환이 필요하고, 표준 기법이 inverse CDF다. CDF<span class="fn-note"><input type="checkbox" id="fn-cdf" class="fn-toggle"><label for="fn-cdf" class="fn-ref">3</label><span class="fn-body"><strong>CDF(cumulative distribution function, 누적분포함수):</strong> "x 이하가 뽑힐 확률"을 담은 함수. PDF를 처음부터 x까지 적분한 것으로, 0에서 1까지 단조 증가한다. 이산 버전은 확률의 누적 합 배열이고, UE 패스 트레이서의 라이트 선택(07장)이 실제로 이 배열을 이진 탐색한다.</span></span>는 "여기까지 뽑힐 확률의 누적 합"인데, 균등 난수 E를 CDF의 역함수에 넣으면 원하는 분포를 따르는 샘플이 나온다.
</p>

<p style="color:var(--text2);line-height:1.85;">
룰렛 원판을 떠올리면 이해하기 쉽다. 당첨 확률이 50%, 30%, 20%인 경품 세 개가 있으면 원판을 180도, 108도, 72도로 나눠 칠하고 바늘을 돌린다. 바늘(균등 난수)은 어디든 같은 확률로 서지만, 넓게 칠한 경품이 자주 나온다. <strong>"확률에 비례해 구간을 나눠 갖게 한 뒤 균등하게 찍는" 것이 inverse CDF의 전부다.</strong> 연속 분포에서는 구간 나누기가 CDF 곡선이 되고, 찍은 위치에서 구간을 되찾는 것이 역함수가 된다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="inverse CDF가 균등 난수를 원하는 분포로 바꾸는 과정">
<rect x="10" y="10" width="740" height="300" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">균등 난수 E (세로축, 같은 간격)</text>
<!-- CDF curve: from (80,270) to (700,60), steep in middle-right -->
<path d="M80 270 C 260 265, 430 240, 520 160 C 580 105, 640 70, 700 62" fill="none" stroke="#3b82c4" stroke-width="2.5"/>
<text x="560" y="150" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#3b82c4" font-weight="700">CDF(x)</text>
<!-- uniform ticks on left axis at equal E spacing, mapped through curve to x axis -->
<g stroke="#9aa3b5" stroke-width="1" stroke-dasharray="4 4">
<line x1="80" y1="244" x2="345" y2="244"/><line x1="345" y1="244" x2="345" y2="270"/>
<line x1="80" y1="218" x2="453" y2="218"/><line x1="453" y1="218" x2="453" y2="270"/>
<line x1="80" y1="192" x2="503" y2="192"/><line x1="503" y1="192" x2="503" y2="270"/>
<line x1="80" y1="166" x2="533" y2="166"/><line x1="533" y1="166" x2="533" y2="270"/>
<line x1="80" y1="140" x2="558" y2="140"/><line x1="558" y1="140" x2="558" y2="270"/>
<line x1="80" y1="114" x2="583" y2="114"/><line x1="583" y1="114" x2="583" y2="270"/>
<line x1="80" y1="88" x2="614" y2="88"/><line x1="614" y1="88" x2="614" y2="270"/>
</g>
<g fill="#b45309">
<circle cx="80" cy="244" r="3.5"/><circle cx="80" cy="218" r="3.5"/><circle cx="80" cy="192" r="3.5"/><circle cx="80" cy="166" r="3.5"/><circle cx="80" cy="140" r="3.5"/><circle cx="80" cy="114" r="3.5"/><circle cx="80" cy="88" r="3.5"/>
</g>
<g fill="#0a8f72">
<circle cx="345" cy="278" r="4"/><circle cx="453" cy="278" r="4"/><circle cx="503" cy="278" r="4"/><circle cx="533" cy="278" r="4"/><circle cx="558" cy="278" r="4"/><circle cx="583" cy="278" r="4"/><circle cx="614" cy="278" r="4"/>
</g>
<line x1="80" y1="278" x2="700" y2="278" stroke="#4b5563" stroke-width="1.5"/>
<text x="330" y="302" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#0a8f72" font-weight="700">결과 샘플 x = CDF⁻¹(E): CDF가 가파른 곳(= PDF가 큰 곳)에 몰린다</text>
</svg>
<div class="scene-cap">세로축의 같은 간격 난수(주황)가 CDF 곡선을 통과하면, 가로축에서는 곡선이 가파른 구간, 즉 확률밀도가 높은 구간에 촘촘히 몰린다(초록). 균등 난수를 원하는 분포로 "워프"하는 원리다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
UE 5.8에서 이 변환들을 모아둔 파일이 <code>Engine/Shaders/Private/MonteCarlo.ush</code>다. 이 파일의 include는 <code>Common.ush</code> 하나뿐이고, 난수 생성기에는 일절 의존하지 않는다. 모든 샘플링 함수는 [0,1)² 난수 E를 <strong>받기만 하고</strong>, E를 어떻게 만들지는 호출자의 책임이다(그 이야기가 06장이다). 관심사 분리가 파일 경계로 드러나 있는 셈이다. 그리고 방향을 뽑는 함수들은 일관되게 <strong>float4를 반환하면서 xyz에 방향(탄젠트 공간, +z가 법선), w에 그 방향의 PDF</strong>를 담는다. 방향만 주고 PDF를 안 주면 f/p를 만들 수 없으니, API 설계 자체가 몬테카를로 추정량의 구조를 강제하고 있다.
</p>

<div class="code-block"><span class="code-lang">HLSL — MonteCarlo.ush (UE 5.8)</span><span class="cm">// PDF = 1 / (4 * PI)</span>
<span class="ty">float4</span> <span class="fn">UniformSampleSphere</span>( <span class="ty">float2</span> E )
{
	<span class="kw">float</span> Phi = <span class="num">2</span> * PI * E.x;
	<span class="kw">float</span> CosTheta = <span class="num">1</span> - <span class="num">2</span> * E.y;	<span class="cm">// 구에서는 z 좌표가 균등 분포다 (아르키메데스의 정리)</span>
	<span class="kw">float</span> SinTheta = <span class="fn">sqrt</span>( <span class="num">1</span> - CosTheta * CosTheta );

	<span class="ty">float3</span> H;
	H.x = SinTheta * <span class="fn">cos</span>( Phi );
	H.y = SinTheta * <span class="fn">sin</span>( Phi );
	H.z = CosTheta;

	<span class="kw">float</span> PDF = <span class="num">1.0</span> / (<span class="num">4</span> * PI);
	<span class="kw">return</span> <span class="ty">float4</span>( H, PDF );
}

<span class="cm">// PDF = NoL / PI</span>
<span class="ty">float4</span> <span class="fn">CosineSampleHemisphere</span>( <span class="ty">float2</span> E )
{
	<span class="kw">float</span> Phi = <span class="num">2</span> * PI * E.x;
	<span class="kw">float</span> CosTheta = <span class="fn">sqrt</span>(E.y);	<span class="cm">// inverse CDF: F(θ) = 1 - cos²θ 를 풀면 cosθ = √E</span>
	<span class="kw">float</span> SinTheta = <span class="fn">sqrt</span>(<span class="num">1</span> - CosTheta * CosTheta);
	...
	<span class="kw">float</span> PDF = CosTheta * (<span class="num">1.0</span> / PI);
	<span class="kw">return</span> <span class="ty">float4</span>(H, PDF);
}</div>

<p style="color:var(--text2);line-height:1.85;">
<code>UniformSampleSphere</code>는 유도랄 것도 없다. 구 표면에서는 z 좌표(cosθ)가 [-1,1]에서 균등하다는 고전 기하 정리를 그대로 코드로 옮겼다. <code>CosineSampleHemisphere</code>가 첫 번째 진짜 inverse CDF다. 목표 분포는 법선에 가까운 방향일수록 자주 뽑히는 p(θ) = cosθ/π이고, 누적해서 뒤집으면 cosθ = √E라는 한 줄이 나온다. 균등 난수에 제곱근 하나 씌웠을 뿐인데 코사인 분포가 된다. 이 두 함수와 GGX 샘플링(04장)의 셋이 "역CDF 유도의 난이도 계단"을 이룬다.
</p>

<p style="color:var(--text2);line-height:1.85;">
반환된 방향은 +z가 법선인 탄젠트 공간 기준이라 월드로 회전해야 한다. 그 헬퍼도 같은 파일에 있다. <code>GetTangentBasis(TangentZ)</code>는 법선 하나로 분기 없이 정규직교 기저(셰이더의 TBN 행렬과 같은 것)를 만들고(Duff et al. 2017), <code>TangentToWorld(Vec, TangentZ)</code>가 회전을 적용한다. 재미있는 지름길도 하나 있다. <code>CosineSampleHemisphere(E, N)</code> 오버로드는 <strong>균등 구 샘플에 법선 N을 더해 normalize</strong>하는데, 이 기하 트릭만으로 코사인 분포가 나와서 탄젠트 기저를 만들 필요가 없다. 월드 방향만 필요할 때 더 싸다는 주석이 붙어 있다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">04 — 임포턴스 샘플링</span>
</div>

# 중요한 곳을 더 자주: 뽑는 분포 p를 피적분 함수 f와 닮게

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
불편성 덕분에 p는 무엇을 골라도 평균은 맞는다. 그러면 무엇이 달라지는가. <strong>분산, 즉 노이즈가 달라진다.</strong> 극단적인 예로 맑은 하늘의 태양을 생각하자. 하늘 전체 밝기의 대부분이 태양이라는 작은 원반에서 오는데, 반구를 균등하게 1000번 찍으면 태양을 밟는 샘플은 거의 없다. 대부분의 샘플은 어두운 하늘값을 돌려주고, 아주 가끔 태양을 밟은 샘플은 가져온 값 f는 거대한데 그 방향이 뽑힐 확률밀도 p는 작아서 f/p가 폭발한다. 평균은 맞지만 픽셀마다 "태양을 밟았냐 아니냐"로 값이 널뛴다. 이 널뜀이 노이즈다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 350" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="균등 샘플링과 임포턴스 샘플링의 비교">
<rect x="10" y="10" width="740" height="330" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">균등 샘플링: 모든 방향을 같은 확률로</text>
<line x1="60" y1="240" x2="330" y2="240" stroke="#4b5563" stroke-width="1.5"/>
<path d="M75 240 A120 120 0 0 1 315 240" fill="none" stroke="#9aa3b5" stroke-width="1" stroke-dasharray="4 4"/>
<circle cx="272" cy="132" r="12" fill="#b45309"/>
<g stroke="#b45309" stroke-width="1.5"><line x1="272" y1="112" x2="272" y2="104"/><line x1="290" y1="120" x2="296" y2="114"/><line x1="292" y1="138" x2="300" y2="140"/><line x1="252" y1="118" x2="246" y2="112"/></g>
<text x="248" y="98" font-family="Segoe UI, sans-serif" font-size="12" fill="#b45309" font-weight="700">태양</text>
<g stroke="#9aa3b5" stroke-width="1.5">
<line x1="195" y1="240" x2="311" y2="209"/><line x1="195" y1="240" x2="280" y2="155"/><line x1="195" y1="240" x2="226" y2="124"/><line x1="195" y1="240" x2="164" y2="124"/><line x1="195" y1="240" x2="110" y2="155"/><line x1="195" y1="240" x2="79" y2="209"/><line x1="195" y1="240" x2="90" y2="180"/>
</g>
<line x1="195" y1="240" x2="264" y2="142" stroke="#b45309" stroke-width="3"/>
<g>
<rect x="106" y="270" width="16" height="16" fill="#cbd5e1"/><rect x="126" y="270" width="16" height="16" fill="#cbd5e1"/><rect x="146" y="270" width="16" height="16" fill="#cbd5e1"/><rect x="166" y="270" width="16" height="16" fill="#b45309"/><rect x="186" y="270" width="16" height="16" fill="#cbd5e1"/><rect x="206" y="270" width="16" height="16" fill="#cbd5e1"/><rect x="226" y="270" width="16" height="16" fill="#cbd5e1"/><rect x="246" y="270" width="16" height="16" fill="#cbd5e1"/>
</g>
<text x="70" y="310" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">샘플값: 거의 0인데 한 발만 f/p 폭발 → 분산 큼</text>
<text x="400" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">임포턴스 샘플링: 태양 쪽을 자주, 대신 큰 p로 나눔</text>
<line x1="430" y1="240" x2="700" y2="240" stroke="#4b5563" stroke-width="1.5"/>
<path d="M445 240 A120 120 0 0 1 685 240" fill="none" stroke="#9aa3b5" stroke-width="1" stroke-dasharray="4 4"/>
<circle cx="642" cy="132" r="12" fill="#b45309"/>
<g stroke="#0a8f72" stroke-width="2">
<line x1="565" y1="240" x2="648" y2="152"/><line x1="565" y1="240" x2="638" y2="145"/><line x1="565" y1="240" x2="655" y2="163"/><line x1="565" y1="240" x2="628" y2="140"/><line x1="565" y1="240" x2="662" y2="176"/><line x1="565" y1="240" x2="616" y2="136"/>
</g>
<g stroke="#9aa3b5" stroke-width="1.2">
<line x1="565" y1="240" x2="500" y2="139"/><line x1="565" y1="240" x2="452" y2="197"/>
</g>
<g fill="#0a8f72">
<rect x="476" y="270" width="16" height="16" opacity="0.85"/><rect x="496" y="270" width="16" height="16" opacity="0.7"/><rect x="516" y="270" width="16" height="16" opacity="0.9"/><rect x="536" y="270" width="16" height="16" opacity="0.75"/><rect x="556" y="270" width="16" height="16" opacity="0.85"/><rect x="576" y="270" width="16" height="16" opacity="0.8"/><rect x="596" y="270" width="16" height="16" opacity="0.9"/><rect x="616" y="270" width="16" height="16" opacity="0.8"/>
</g>
<text x="440" y="310" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">샘플값 f/p: 전부 비슷 → 분산 작음, 평균은 왼쪽과 동일</text>
</svg>
<div class="scene-cap">하늘 전체 밝기의 대부분이 작은 태양에서 온다. 왼쪽처럼 균등하게 뽑으면 태양을 밟은 한 발만 f/p가 폭발해 픽셀 값이 널뛴다. 오른쪽처럼 태양 방향을 자주 뽑되 그만큼 커진 p로 나누면 모든 샘플이 비슷한 값을 돌려준다. 두 방식의 평균(정답)은 같고, 널뛰는 정도(노이즈)만 다르다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
해결은 f/p라는 식 자체에 들어 있다. <strong>만약 뽑는 분포 p가 피적분 함수 f와 정확히 비례한다면 f/p는 모든 샘플에서 같은 상수가 되고, 분산은 0이 된다.</strong> 어떤 샘플을 뽑아도 같은 값이니 한 발만 쏘면 끝이다. 물론 완벽한 비례는 불가능하다. p를 f에 비례하게 정규화하려면 f의 적분값을 알아야 하는데 그것이 바로 구하려는 답이기 때문이다. 그래서 실전 전략은 이렇다. <strong>f에서 식을 아는 부분만이라도 닮은 p를 쓰고, 나머지는 f/p의 잔차로 남긴다.</strong> 이것이 임포턴스 샘플링(importance sampling)이고, "중요한(f가 큰) 방향을 더 자주 뽑되 그만큼 나눠서 보정한다"는 말의 정확한 의미다.
</p>

<p style="color:var(--text2);line-height:1.85;">
가장 깨끗한 예가 Lambert 재질이다. 피적분 함수는 (albedo/π) × L<sub>i</sub> × cosθ인데, 이 중 식을 아는 부분은 cosθ다. 그러니 03장의 코사인 반구 샘플링(p = cosθ/π)을 쓰면 샘플 가중치 BRDF·cosθ/p = (albedo/π)·cosθ ÷ (cosθ/π)에서 <strong>cosθ와 π가 통째로 소거되고 albedo만 남는다.</strong> UE 패스 트레이서의 Lambert 재질이 문자 그대로 이렇다.
</p>

<div class="code-block"><span class="code-lang">HLSL — PathTracing/Material/PathTracingLambert.ush (UE 5.8)</span><span class="cm">// 샘플 방향은 코사인 반구에서. Weight(= f·cos/pdf)는 BaseColor만 남는다</span>
<span class="ty">float4</span> SampledValue = <span class="fn">CosineSampleHemisphereWorld</span>(RandSample.xy, N_World);
<span class="kw">return</span> <span class="fn">CreateMaterialSample</span>(L_World, Payload.BSDFOpacity * BaseColor * ShadowTerminator,
                            SampledValue.w, <span class="num">1.0</span>, <span class="num">1.0</span>, PATHTRACER_SCATTER_DIFFUSE);</div>

<p style="color:var(--text2);line-height:1.85;">
스페큘러 재질에서는 p가 GGX BRDF를 닮아야 한다. <a href="/brdf">BRDF 글</a>에서 본 것처럼 스페큘러 BRDF의 모양을 지배하는 것은 미세면 법선 분포 NDF<span class="fn-note"><input type="checkbox" id="fn-ndf" class="fn-toggle"><label for="fn-ndf" class="fn-ref">4</label><span class="fn-body"><strong>NDF(normal distribution function, 미세면 법선 분포):</strong> microfacet BRDF에서 "법선이 특정 방향인 미세 거울 조각이 얼마나 많은가"를 담는 D 항. UE의 기본값은 GGX(Trowbridge-Reitz)이고, 하이라이트의 모양과 크기를 결정한다. 자세한 내용은 BRDF 글의 04~05장.</span></span>이므로, 하프벡터 H를 D(H)에 비례해 뽑는다. 하프벡터는 뷰 벡터 V와 라이트 방향 L의 정중앙 방향으로, 법선이 정확히 H인 미세 거울 조각만 V에서 온 빛을 L로 반사한다. 그래서 "미세면 법선을 뽑는다"와 "H를 뽑는다"는 같은 말이다. 그 inverse CDF가 <code>ImportanceSampleGGX</code>다.
</p>

<div class="code-block"><span class="code-lang">HLSL — MonteCarlo.ush (UE 5.8)</span><span class="cm">// PDF = D * NoH / (4 * VoH)</span>
<span class="ty">float4</span> <span class="fn">ImportanceSampleGGX</span>( <span class="ty">float2</span> E, <span class="kw">float</span> a2 )
{
	<span class="kw">float</span> Phi = <span class="num">2</span> * PI * E.x;
	<span class="kw">float</span> CosTheta = <span class="fn">sqrt</span>( (<span class="num">1</span> - E.y) / ( <span class="num">1</span> + (a2 - <span class="num">1</span>) * E.y ) );	<span class="cm">// GGX의 inverse CDF</span>
	<span class="kw">float</span> SinTheta = <span class="fn">sqrt</span>( <span class="num">1</span> - CosTheta * CosTheta );

	<span class="ty">float3</span> H;
	H.x = SinTheta * <span class="fn">cos</span>( Phi );
	H.y = SinTheta * <span class="fn">sin</span>( Phi );
	H.z = CosTheta;

	<span class="kw">float</span> d = ( CosTheta * a2 - CosTheta ) * CosTheta + <span class="num">1</span>;
	<span class="kw">float</span> D = a2 / ( PI*d*d );	<span class="cm">// BRDF.ush의 D_GGX와 문자 그대로 같은 식</span>
	<span class="kw">float</span> PDF = D * CosTheta;	<span class="cm">// w에 실제로 담기는 값: 하프벡터 기준 D(h)·cosθ_h</span>

	<span class="kw">return</span> <span class="ty">float4</span>( H, PDF );
}</div>

<div class="callout callout-warn">
<div class="callout-title">함정: 주석의 PDF와 반환값의 PDF가 다르다</div>
<p>함수 위 주석은 <code>PDF = D * NoH / (4 * VoH)</code>인데 반환값 w에 담기는 것은 <code>D * CosTheta</code>, 즉 <strong>하프벡터 H 기준의 PDF</strong>다. 우리가 실제로 쏘는 것은 H가 아니라 V를 H에 반사시킨 방향 L이고, "H를 뽑는 밀도"를 "L을 뽑는 밀도"로 바꾸려면 변수 변환 계수 1/(4·VoH)를 곱해야 한다. 그 역할은 같은 파일의 별도 헬퍼 <code>RayPDFToReflectionRayPDF(VoH, RayPDF)</code>가 맡는다. 주석은 "최종 L의 PDF"를 설명하고 반환값은 변환 전이라, 소비처 코드를 읽을 때 지금 어느 도메인의 PDF인지 먼저 확인해야 한다. 참고로 NoH, VoH 같은 이름은 dot(N,H), dot(V,H), 즉 두 벡터의 내적을 뜻하는 UE 셰이더 관례다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
효과는 프리필터 수치로 바로 확인된다. 리플렉션 캡처의 GGX 컨볼루션(<a href="/reflection-capture">Reflection Capture 글</a>의 그 프리필터)은 레퍼런스가 1024샘플인데, 실전 코드는 GGX 임포턴스 샘플링 덕분에 32~64샘플로 돌아간다(10장에서 다시 본다). 참고로 UE4 시절 이 파일에 있던 <code>ImportanceSampleBlinn</code>은 5.8.1 셰이더 트리 전체에서 사라졌다. Karis 2013 노트를 인용할 때 현행 소스에는 없다는 것을 기억해 둘 것.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">05 — VNDF</span>
</div>

# 한 단계 더: 보이는 미세면만 뽑기

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
NDF 샘플링에는 낭비가 남아 있다. D(H)는 "그 방향의 미세면이 얼마나 많은가"만 보고 <strong>지금 카메라에서 그 미세면이 보이는지는 안 본다.</strong> 거친 표면을 비스듬히 볼 때, 카메라 반대쪽으로 기운 미세면을 뽑으면 반사 방향이 표면 아래로 들어가 버려서 샘플이 통째로 버려진다. 기여가 0인 샘플에 ray 예산을 쓴 셈이고, 이것도 분산이다. 그래서 나온 것이 가시 법선 분포(VNDF, visible normal distribution function) 샘플링이다. 뷰 벡터 V에서 <strong>실제로 보이는 미세면만</strong>을 그 보이는 면적에 비례해 뽑는다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="NDF 샘플링과 VNDF 샘플링의 차이">
<rect x="10" y="10" width="740" height="280" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">NDF 샘플링: 안 보이는 미세면도 개수대로 뽑는다</text>
<polyline points="50,230 80,212 110,230 140,216 170,232 200,214 230,230 260,218 290,232 320,214 350,230" fill="none" stroke="#4b5563" stroke-width="2"/>
<defs>
<marker id="mcArrB" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#3b82c4"/></marker>
<marker id="mcArrO" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#b45309"/></marker>
<marker id="mcArrR" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#c0392b"/></marker>
<marker id="mcArrG" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#0a8f72"/></marker>
</defs>
<line x1="70" y1="140" x2="196" y2="217" stroke="#3b82c4" stroke-width="2.5" marker-end="url(#mcArrB)"/>
<text x="52" y="130" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#3b82c4" font-weight="700">V (비스듬히 본다)</text>
<line x1="200" y1="214" x2="245" y2="170" stroke="#b45309" stroke-width="2.5" marker-end="url(#mcArrO)"/>
<text x="250" y="165" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#b45309" font-weight="700">뽑힌 미세면 법선 H</text>
<line x1="200" y1="214" x2="300" y2="262" stroke="#c0392b" stroke-width="2.5" marker-end="url(#mcArrR)"/>
<text x="212" y="272" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#c0392b" font-weight="700">반사 방향 L이 표면 아래로 ✕ 기여 0</text>
<text x="400" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">VNDF 샘플링: V에서 보이는 미세면만 뽑는다</text>
<polyline points="420,230 450,212 480,230 510,216 540,232 570,214 600,230 630,218 660,232 690,214 720,230" fill="none" stroke="#4b5563" stroke-width="2"/>
<line x1="440" y1="140" x2="566" y2="217" stroke="#3b82c4" stroke-width="2.5" marker-end="url(#mcArrB)"/>
<text x="422" y="130" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#3b82c4" font-weight="700">V</text>
<line x1="570" y1="214" x2="580" y2="152" stroke="#b45309" stroke-width="2.5" marker-end="url(#mcArrO)"/>
<text x="588" y="150" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#b45309" font-weight="700">H (보이는 면만)</text>
<line x1="570" y1="214" x2="688" y2="128" stroke="#0a8f72" stroke-width="2.5" marker-end="url(#mcArrG)"/>
<text x="600" y="105" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#0a8f72" font-weight="700">L이 항상 유효 ✓</text>
</svg>
<div class="scene-cap">거친 표면을 비스듬히 볼 때의 차이다. NDF 샘플링(왼쪽)은 "그 방향의 미세면이 몇 개인가"만 보고 뽑으므로 카메라 반대쪽으로 기운 미세면도 뽑히고, 그 미세면에 반사된 방향은 표면 아래로 들어가 샘플이 통째로 버려진다. VNDF 샘플링(오른쪽)은 뷰 벡터 V에서 실제로 보이는 미세면만 뽑아, 같은 ray 예산으로 유효한 샘플만 만든다.</div>
</div>

<div class="code-block"><span class="code-lang">HLSL — MonteCarlo.ush (UE 5.8)</span><span class="cm">// PDF = G_SmithV * D / (4 * NoV)</span>
<span class="ty">float4</span> <span class="fn">ImportanceSampleVisibleGGX</span>(<span class="ty">float2</span> E, <span class="ty">float2</span> Alpha, <span class="ty">float3</span> V, <span class="kw">bool</span> bLimitVDNFToReflection = <span class="kw">true</span>)
{
	<span class="cm">// stretch: 러프니스로 늘린 공간에서는 GGX가 완전한 반구가 된다</span>
	<span class="ty">float3</span> Vh = <span class="fn">normalize</span>(<span class="ty">float3</span>(Alpha * V.xy, V.z));
	<span class="kw">float</span> Phi = (<span class="num">2</span> * PI) * E.x;
	<span class="kw">float</span> k = <span class="num">1.0</span>;
#if GGX_BOUNDED_VNDF_SAMPLING	<span class="cm">// 기본 1: 반사 가능한 범위로 캡을 더 조인다 [Eto &amp; Tokuyoshi 2023]</span>
	...
	k = (s2 - a2 * s2) / (s2 + a2 * V.z * V.z);
#endif
	<span class="kw">float</span> Z = <span class="fn">lerp</span>(<span class="num">1.0</span>, -k * Vh.z, E.y);	<span class="cm">// 구면 캡 안에서 z 균등 [Dupuy &amp; Benyoub 2023]</span>
	<span class="kw">float</span> SinTheta = <span class="fn">sqrt</span>(<span class="fn">saturate</span>(<span class="num">1</span> - Z * Z));
	<span class="ty">float3</span> H = <span class="ty">float3</span>(SinTheta * <span class="fn">cos</span>(Phi), SinTheta * <span class="fn">sin</span>(Phi), Z) + Vh;
	<span class="cm">// unstretch</span>
	H = <span class="fn">normalize</span>(<span class="ty">float3</span>(Alpha * H.xy, <span class="fn">max</span>(<span class="num">0.0</span>, H.z)));
	<span class="kw">return</span> <span class="ty">float4</span>(H, <span class="fn">VisibleGGXPDF_aniso</span>(V, H, Alpha, bLimitVDNFToReflection));
}</div>

<p style="color:var(--text2);line-height:1.85;">
5.8.1의 구현은 UE4 시절의 Heitz 2018 방식이 아니라 2023년 논문 두 편의 콤보다. Dupuy &amp; Benyoub(HPG 2023)의 구면 캡 샘플링 위에, Eto &amp; Tokuyoshi(SIGGRAPH Asia 2023)의 Bounded VNDF가 얹혀 있다. 후자는 반사 전용일 때 캡 범위를 한 번 더 조여서(위 코드의 k 인자) 수평선 아래로 반사될 샘플을 사전에 제거한다. 거친 금속의 멀티바운스 반사에서 버려지는 ray가 크게 준다는 주석이 붙어 있고, 기본 활성이다. 이방성 러프니스(<code>float2 Alpha</code>)도 지원하고, 유리처럼 굴절에도 H를 쓰는 재질은 <code>bLimitVDNFToReflection=false</code>로 부른다.
</p>

<p style="color:var(--text2);line-height:1.85;">
VNDF의 진짜 매력은 샘플 가중치(BRDF × cosθ ÷ PDF)를 계산해 보면 나타난다. VNDF의 PDF는 G1(V)·D/(4·NoV)인데, 이것을 GGX BRDF의 D·G·F/(4·NoV·NoL)(D = NDF, G = 마스킹·섀도잉, F = 프레넬. <a href="/brdf">BRDF 글</a>의 그 세 항이다)와 나눠 보면 <strong>D와 G1(V), 분모 4·NoV가 전부 소거되고 F·(G2/G1) ≈ F·G<sub>SmithL</sub>만 남는다.</strong> Lambert에서 cosθ/π가 사라졌던 것과 같은 종류의 소거가 스페큘러에서도 일어나는 것이다. 이 사실은 소스 주석에 세 전략의 비교표로 박혀 있다.
</p>

<div class="code-block"><span class="code-lang">HLSL — SSRT/SSRTReflections.usf · ShadingModelsSampling.ush (UE 5.8, 주석 원문)</span><span class="cm">#if 0	// CosineSampleHemisphere:      PDF = NoL / PI</span>
<span class="cm">	SampleColor.rgb *= F * (D * Vis * PI);</span>
<span class="cm">#elif 0	// ImportanceSampleGGX:         PDF = D * NoH / (4 * VoH)</span>
<span class="cm">	SampleColor.rgb *= F * ( NoL * Vis * (4 * VoH / NoH) );</span>
<span class="cm">#elif 0	// ImportanceSampleVisibleGGX:  PDF = G_SmithV * D / (4 * NoV)</span>
<span class="cm">	SampleColor.rgb *= F * G_SmithL;	// 남는 항이 이것뿐</span>
<span class="cm">#endif</span></div>

<p style="color:var(--text2);line-height:1.85;">
p가 f를 닮을수록 잔차 f/p가 단순해지고, 잔차가 단순할수록(변동이 작을수록) 분산이 작다. 코사인 → NDF → VNDF로 갈수록 남는 항이 줄어드는 이 사다리가 임포턴스 샘플링의 발전사 그 자체다. 5.8 소비처들의 현행 기본값은 SSR, Lumen 리플렉션, 패스 트레이서 재질 전부 VNDF다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">06 — 난수의 선택</span>
</div>

# 어떤 난수를 쓰는가: Sobol, 블루노이즈, Halton의 역할 분담

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
지금까지 E는 그냥 "균등 난수"였다. 그런데 순수한 무작위(백색 노이즈)에는 문제가 있다. 무작위 점은 <strong>뭉친다.</strong> 동전을 열 번 던지면 앞면이 연달아 나오는 구간이 생기듯, 무작위 점 64개를 찍으면 어떤 곳은 점이 겹치고 어떤 곳은 텅 빈다. 겹친 점은 같은 정보를 두 번 산 것이라 낭비다. 그래서 실전에서는 "무작위처럼 보이지만 서로 밀어내며 공간을 고르게 덮는" 점열을 쓴다. 이런 점열을 저불일치<span class="fn-note"><input type="checkbox" id="fn-lds" class="fn-toggle"><label for="fn-lds" class="fn-ref">5</label><span class="fn-body"><strong>저불일치 시퀀스(low-discrepancy sequence):</strong> 불일치(discrepancy)는 "점들이 공간을 얼마나 고르지 못하게 덮는가"의 측도다. Halton, Sobol, Hammersley 같은 저불일치 시퀀스는 결정론적 규칙으로 점을 만들어 어떤 부분 영역을 잘라 봐도 점 개수가 면적에 비례하게 유지한다. 이것을 쓰는 몬테카를로를 준 몬테카를로(QMC)라고 부르고, 수렴이 1/√N보다 빨라진다.</span></span> 시퀀스라고 부르고, UE 5.8은 자리마다 다른 것을 골라 쓴다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="백색 노이즈, 저불일치 시퀀스, 블루노이즈의 점 분포 비교">
<rect x="10" y="10" width="740" height="300" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="80" y="45" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">백색 노이즈</text>
<text x="300" y="45" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">저불일치 (Sobol 계열)</text>
<text x="565" y="45" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">블루노이즈</text>
<rect x="45" y="60" width="190" height="190" fill="none" stroke="#d5dbe6"/>
<rect x="285" y="60" width="190" height="190" fill="none" stroke="#d5dbe6"/>
<rect x="525" y="60" width="190" height="190" fill="none" stroke="#d5dbe6"/>
<g fill="#3b82c4">
<circle cx="65" cy="90" r="3"/><circle cx="73" cy="96" r="3"/><circle cx="69" cy="85" r="3"/><circle cx="115" cy="80" r="3"/><circle cx="195" cy="75" r="3"/><circle cx="205" cy="82" r="3"/><circle cx="200" cy="90" r="3"/><circle cx="85" cy="150" r="3"/><circle cx="85" cy="158" r="3"/><circle cx="80" cy="145" r="3"/><circle cx="165" cy="130" r="3"/><circle cx="215" cy="155" r="3"/><circle cx="135" cy="170" r="3"/><circle cx="140" cy="178" r="3"/><circle cx="105" cy="210" r="3"/><circle cx="110" cy="218" r="3"/><circle cx="103" cy="205" r="3"/><circle cx="185" cy="200" r="3"/><circle cx="225" cy="230" r="3"/><circle cx="65" cy="230" r="3"/><circle cx="155" cy="235" r="3"/><circle cx="150" cy="105" r="3"/><circle cx="120" cy="120" r="3"/>
</g>
<circle cx="192" cy="112" r="24" fill="none" stroke="#c0392b" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="170" y="115" font-family="Segoe UI, sans-serif" font-size="11" fill="#c0392b">빈 곳</text>
<circle cx="70" cy="91" r="16" fill="none" stroke="#c0392b" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="52" y="122" font-family="Segoe UI, sans-serif" font-size="11" fill="#c0392b">뭉침</text>
<g fill="#3b82c4">
<circle cx="300" cy="78" r="3"/><circle cx="338" cy="88" r="3"/><circle cx="376" cy="75" r="3"/><circle cx="414" cy="85" r="3"/><circle cx="452" cy="80" r="3"/><circle cx="305" cy="115" r="3"/><circle cx="343" cy="122" r="3"/><circle cx="381" cy="112" r="3"/><circle cx="419" cy="120" r="3"/><circle cx="457" cy="115" r="3"/><circle cx="300" cy="155" r="3"/><circle cx="338" cy="148" r="3"/><circle cx="376" cy="158" r="3"/><circle cx="414" cy="152" r="3"/><circle cx="452" cy="148" r="3"/><circle cx="305" cy="190" r="3"/><circle cx="343" cy="185" r="3"/><circle cx="381" cy="195" r="3"/><circle cx="419" cy="188" r="3"/><circle cx="457" cy="192" r="3"/><circle cx="300" cy="228" r="3"/><circle cx="338" cy="232" r="3"/><circle cx="376" cy="225" r="3"/><circle cx="414" cy="230" r="3"/><circle cx="452" cy="235" r="3"/>
</g>
<g fill="#3b82c4">
<circle cx="550" cy="80" r="3"/><circle cx="595" cy="75" r="3"/><circle cx="645" cy="85" r="3"/><circle cx="690" cy="78" r="3"/><circle cx="570" cy="110" r="3"/><circle cx="620" cy="115" r="3"/><circle cx="670" cy="108" r="3"/><circle cx="540" cy="140" r="3"/><circle cx="590" cy="145" r="3"/><circle cx="640" cy="150" r="3"/><circle cx="695" cy="140" r="3"/><circle cx="560" cy="175" r="3"/><circle cx="613" cy="180" r="3"/><circle cx="665" cy="178" r="3"/><circle cx="705" cy="170" r="3"/><circle cx="535" cy="205" r="3"/><circle cx="585" cy="212" r="3"/><circle cx="638" cy="208" r="3"/><circle cx="688" cy="215" r="3"/><circle cx="558" cy="238" r="3"/><circle cx="612" cy="242" r="3"/><circle cx="662" cy="238" r="3"/><circle cx="532" cy="172" r="3"/>
</g>
<text x="45" y="278" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">겹치고 비는 곳이 생긴다</text>
<text x="285" y="278" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">결정론적 규칙으로 고르게 덮는다</text>
<text x="525" y="278" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">고르되 무작위처럼 보인다 (고주파)</text>
</svg>
<div class="scene-cap">같은 개수의 점이라도 뿌리는 방식이 다르다. 순수 무작위(왼쪽)는 점이 뭉치고 비는 곳이 생기는데, 뭉친 점은 같은 정보를 두 번 산 것이라 낭비다. 저불일치 시퀀스(가운데)는 어느 부분을 잘라 봐도 점 개수가 면적에 비례하게 유지되어 같은 N으로 더 정확하다. 블루노이즈(오른쪽)는 고르게 덮으면서 남는 오차를 고주파에 몰아 두어, 뒤에서 TAA와 디노이저가 이웃과 평균 낼 때 잘 지워지는 형태다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
가장 단순한 것이 <code>MonteCarlo.ush</code> 안에 동거하는 <code>Hammersley</code>다. 첫 좌표는 i/N으로 등간격, 둘째 좌표는 인덱스의 비트를 뒤집은 값(radical inverse)이다. 샘플 수 N을 미리 알 때 쓰는 고정 점열로, 리플렉션 프리필터와 SSR이 쓴다. 한 급 위가 Sobol인데, 5.8의 주력은 패스 트레이서의 <code>PathTracingRandomSequence.ush</code>에 있는 <strong>Owen-scrambled Sobol</strong>이다. 재미있는 것은 구현 방식이다. 고전 구현처럼 미리 계산된 상수 테이블(방향수 테이블)을 들고 다니지 않고, 2024~2025년 논문의 비트 트릭 덕분에 테이블 없이 비트 연산만으로 Sobol 점을 즉석 계산한 뒤, Owen 스크램블링(점열의 고른 성질은 보존하면서 패턴만 뒤섞는 무작위화)을 4줄짜리 근사 해시로 처리한다.
</p>

<div class="code-block"><span class="code-lang">HLSL — PathTracing/Utilities/PathTracingRandomSequence.ush (UE 5.8)</span><span class="cm">// This simple tweak appears to be nearly as good as the reference, while being cheaper to compute</span>
<span class="ty">uint</span> <span class="fn">FastOwenScramblingCore</span>(<span class="ty">uint</span> Index, <span class="ty">uint</span> Seed)
{
	Index ^= Index * <span class="num">0xe0705d72u</span>;
	Index += Seed;
	Seed ^= Seed >> <span class="num">16</span>;
	Index *= Seed | <span class="num">1</span>;
	<span class="kw">return</span> Index;
}</div>

<p style="color:var(--text2);line-height:1.85;">
패스 트레이서의 기본 모드는 여기서 한 걸음 더 간다. 픽셀마다 독립 시퀀스를 주는 대신, <strong>화면 전체가 하나의 Sobol 시퀀스를 공유하고 힐베르트 곡선(화면을 한 붓 그리기로 빠짐없이 훑는 지그재그 순회)으로 픽셀에 인덱스를 배분</strong>한다(에러 확산 샘플러, <code>r.PathTracing.SamplerType</code>). 이렇게 하면 남은 오차가 이웃 픽셀끼리 상쇄되는 방향으로 퍼져서 같은 SPP에서 눈에 띄게 덜 지저분하다. 대신 주석이 대가를 정직하게 적어 뒀다. "목표 샘플 수 이후에는 품질이 더 늘지 않는다". 수렴 품질을 목표 SPP에 최적화한, 오프라인 지향의 설계다. GPU Lightmass도 같은 시퀀스를 그대로 include한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
실시간 쪽의 주력은 전혀 다르다. Lumen, MegaLights, VSM이 쓰는 것은 <strong>공간·시간 블루노이즈 텍스처</strong>(STBN, 128×128×64)다. 픽셀 좌표와 프레임 인덱스로 룩업하는 구운 텍스처인데, 화면 공간(xy)에서도 프레임 축(z)에서도 저주파 성분이 없도록 설계됐다. 헤더 주석이 용도를 명시한다: "designed to work with temporal accumulation". 어차피 뒤에서 TAA와 디노이저가 이웃 픽셀과 지난 프레임을 평균낼 것이므로, <strong>그 평균이 잘 되도록 오차를 고주파에 몰아 두는 것</strong>이다. 그보다 더 싼 최하층에는 7 ALU짜리 Interleaved Gradient Noise(레이마칭 스텝 오프셋, 디더링)와 PCG 해시(<code>Rand3DPCG16</code>)가 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 Halton. <a href="/taa">TAA</a>의 서브픽셀 지터가 Halton(2,3)이라는 것은 유명한데, 위치가 의외다. TemporalAA.cpp가 아니라 <strong>뷰 셋업을 하는 SceneVisibility.cpp</strong>에 있다. 시퀀스 길이는 <code>r.TemporalAASamples</code>(기본 8)이고, TSR은 여기서 한 번 더 머리를 쓴다. 샘플 수를 <strong>바로 위의 소수(prime)로 올림</strong>해서, 2의 거듭제곱 주기로 도는 다른 난수 신호들과 지터 시퀀스가 간섭(공진)하지 않게 한다.
</p>

<table class="data-table">
<tr><th>시퀀스</th><th>정의 위치 (UE 5.8 실명)</th><th>주 소비처</th><th>선택 이유</th></tr>
<tr><td>Owen-scrambled Sobol</td><td><code>PathTracingRandomSequence.ush</code> (FRandomSequence)</td><td>패스 트레이서, GPU Lightmass, RT 섀도우·AO, Lumen HWRT</td><td>수렴 품질. 목표 SPP까지 오차 최소화</td></tr>
<tr><td>블루노이즈 (STBN)</td><td><code>BlueNoise.ush</code> (BlueNoiseScalar/Vec2)</td><td>MegaLights, Lumen, VSM SMRT 등 44개 파일</td><td>TAA·디노이저가 평균 내기 좋은 고주파 오차</td></tr>
<tr><td>Hammersley</td><td><code>MonteCarlo.ush</code></td><td>리플렉션 프리필터, SSR</td><td>샘플 수 고정, 스크램블만 픽셀별</td></tr>
<tr><td>Halton</td><td><code>Core/Math/Halton.h</code> (C++)</td><td>TAA/TSR 지터(SceneVisibility.cpp), 볼류메트릭 포그 지터</td><td>임의 길이에서 고른 커버리지</td></tr>
<tr><td>IGN · PCG 해시</td><td><code>RandomInterleavedGradientNoise.ush</code> · <code>RandomPCG.ush</code></td><td>레이마칭 오프셋, 디더, 폴백 경로</td><td>7~8 ALU. 텍스처 룩업조차 아끼는 자리</td></tr>
<tr><td>16비트 Sobol 텍스처</td><td><code>SobolRandom.ush</code> (SobolPixel/SobolIndex)</td><td>RectLight 적분, PCSS, SSD 디노이저 (3곳뿐)</td><td>레거시. 주력은 FRandomSequence로 이동</td></tr>
</table>

<p style="color:var(--text2);line-height:1.85;">
정리하면 선택 기준은 하나다. <strong>이 샘플의 오차를 뒤에서 누가 받아주는가.</strong> 아무도 안 받아주고 그대로 수렴해야 하면 Sobol, TAA와 디노이저가 시공간으로 평균해 주면 블루노이즈, 디더 한 번이면 IGN이다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">07 — NEE</span>
</div>

# 라이트를 직접 겨냥하기: Next Event Estimation

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
04장까지의 임포턴스 샘플링은 전부 BRDF를 닮는 이야기였다. 그런데 피적분 함수의 나머지 절반은 들어오는 빛 L<sub>i</sub>이고, 빛은 대부분 라이트에서 온다. BRDF만 보고 방향을 뽑으면 작은 라이트는 거의 못 맞힌다. 방 전체를 밝히는 전구도 셰이딩 포인트에서 보면 겉보기 크기(입체각. 반구 전체가 2π 스테라디안)로는 반구의 수만분의 일이라서, 거친 표면에서 BRDF 샘플링으로 전구를 맞힐 확률은 사실상 0이다. 그래서 모든 패스 트레이서는 매 바운스에서 <strong>라이트를 향해 별도의 그림자 ray를 직접 쏜다.</strong> 이 기법이 NEE<span class="fn-note"><input type="checkbox" id="fn-nee" class="fn-toggle"><label for="fn-nee" class="fn-ref">6</label><span class="fn-body"><strong>NEE(next event estimation):</strong> 경로가 라이트에 우연히 닿기를 기다리지 않고, 매 셰이딩 포인트에서 라이트 위의 한 점을 직접 샘플링해 가시성만 그림자 ray로 확인하는 기법. "다음 사건(라이트 도달)을 지금 추정한다"는 뜻의 입자 수송 용어를 그대로 가져왔다. direct light sampling이라고도 부른다.</span></span>다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="BRDF 샘플링과 NEE 그림자 ray의 비교">
<rect x="10" y="10" width="740" height="280" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<line x1="60" y1="250" x2="700" y2="250" stroke="#4b5563" stroke-width="2"/>
<path d="M90 250 A150 150 0 0 1 390 250" fill="none" stroke="#9aa3b5" stroke-width="1" stroke-dasharray="4 4"/>
<g stroke="#9aa3b5" stroke-width="1.5">
<line x1="240" y1="250" x2="381" y2="199"/><line x1="240" y1="250" x2="346" y2="144"/><line x1="240" y1="250" x2="291" y2="109"/><line x1="240" y1="250" x2="214" y2="102"/><line x1="240" y1="250" x2="134" y2="144"/><line x1="240" y1="250" x2="99" y2="199"/>
</g>
<text x="95" y="90" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#9aa3b5" font-weight="700">BRDF 샘플링: 반구 어딘가로. 작은 광원을 우연히 맞을 확률 ≈ 0</text>
<circle cx="240" cy="250" r="5" fill="#4b5563"/>
<text x="180" y="272" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#4b5563" font-weight="700">셰이딩 포인트</text>
<circle cx="590" cy="90" r="12" fill="#b45309"/>
<g stroke="#b45309" stroke-width="1.5"><line x1="590" y1="70" x2="590" y2="62"/><line x1="608" y1="78" x2="614" y2="72"/><line x1="572" y1="78" x2="566" y2="72"/><line x1="610" y1="96" x2="618" y2="98"/></g>
<text x="612" y="66" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#b45309" font-weight="700">작은 광원</text>
<defs><marker id="mc7ArrG" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#0a8f72"/></marker></defs>
<line x1="240" y1="250" x2="578" y2="99" stroke="#0a8f72" stroke-width="2.5" stroke-dasharray="8 5" marker-end="url(#mc7ArrG)"/>
<text x="360" y="205" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#0a8f72" font-weight="700">NEE: 광원 위의 점을 직접 겨냥한 그림자 ray</text>
<text x="360" y="223" font-family="Segoe UI, sans-serif" font-size="12" fill="#0a8f72">(가시성만 확인, 기여는 광원 선택 확률과 PDF로 나눠 보정)</text>
</svg>
<div class="scene-cap">BRDF만 닮은 p는 반구 전체에 ray를 흩뿌리므로, 입체각이 반구의 수만분의 일인 작은 광원은 사실상 못 맞힌다(회색). NEE는 매 바운스에서 광원 위의 한 점을 별도로 뽑아 그쪽으로 그림자 ray를 쏘고(초록), 그 샘플이 뽑힐 확률(광원 선택 확률 × 광원 위 점의 PDF)로 나눠 보정한다. 광원이 보이기만 하면 매 샘플이 직접광 기여를 확실하게 가져온다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
NEE는 두 단계의 임포턴스 샘플링이다. 먼저 <strong>어느 라이트를 겨냥할지</strong> 고른다. UE 패스 트레이서는 셰이딩 포인트마다 각 라이트의 기여를 추정하고(<code>EstimateLight</code>: 파워 × 거리 감쇠 × 코사인 근사), 그 추정치로 누적 합 배열을 만들어 이진 탐색으로 고른다(<code>SelectLight</code>). 03장의 룰렛 원판을 코드로 옮긴 이산 임포턴스 샘플링 실물이고, 선택 확률 <code>LightPickPdf</code>는 나중에 최종 PDF에 곱으로 들어간다(최종 PDF = 라이트 선택 확률 × 라이트 위 점의 PDF). 라이트가 수백 개면 이 루프도 비싸니, 씬을 그리드로 나눠 셀마다 후보를 미리 추려 둔다(라이트 그리드).
</p>

<p style="color:var(--text2);line-height:1.85;">
다음은 <strong>그 라이트의 어디를 겨냥할지</strong>다. 면광원은 표면 위의 한 점을 뽑아야 하는데, UE는 면적이 아니라 <strong>처음부터 입체각 도메인에서</strong> 샘플링한다. 구형 라이트는 셰이딩 포인트에서 보이는 원뿔을 균등하게(<code>UniformSampleConeRobust</code>, PDF = 원뿔 입체각의 역수), 사각 라이트는 구면에 투영된 사각형을 균등하게(Ureña의 spherical rectangle, <code>UniformSampleSphericalRect</code>) 뽑는다. 같은 파일에 "무엇을 균등하게 뽑느냐에 따라 PDF가 달라진다"를 이보다 잘 보여줄 수 없는 코드가 있다.
</p>

<div class="code-block"><span class="code-lang">HLSL — RectLight.ush (UE 5.8)</span><span class="kw">float</span> <span class="fn">GetSphericalRectInversePdf</span>(<span class="ty">float3</span> Direction, <span class="kw">float</span> DistanceSquared, <span class="ty">FSphericalRect</span> Rect)
{
	<span class="kw">if</span> (Rect.SolidAngle > SPHERICAL_RECT_MIN_SOLIDANGLE)
	{
		<span class="cm">// 입체각 균등 샘플링: pdf = 1/Ω → invPdf = Ω</span>
		<span class="kw">return</span> Rect.SolidAngle;
	}
	<span class="kw">else</span>
	{
		<span class="cm">// 라이트가 아주 작으면 면적 샘플링으로 폴백. PDF도 면적→입체각 환산식으로 교체된다</span>
		<span class="kw">float</span> Area = (Rect.y1 - Rect.y0) * (Rect.x1 - Rect.x0);
		<span class="kw">float</span> NoL = <span class="fn">abs</span>(<span class="fn">dot</span>(Direction, Rect.Axis[<span class="num">2</span>]));
		<span class="kw">return</span> Area * NoL / DistanceSquared;
	}
}</div>

<p style="color:var(--text2);line-height:1.85;">
같은 사각형 위의 같은 점이라도, "면적을 균등하게 뽑았다"면 PDF는 1/면적이고 그것을 방향의 밀도로 쓰려면 거리 제곱과 코사인으로 환산해야 한다. "입체각을 균등하게 뽑았다"면 그냥 1/Ω이다. PDF는 점의 속성이 아니라 <strong>뽑은 절차의 속성</strong>이라는 것, 몬테카를로 코드를 읽을 때 가장 헷갈리기 쉬운 지점이다. 이렇게 방향과 PDF가 정해지면 기여는 교과서 공식 그대로 조립된다. 아래 코드의 <code>PathThroughput</code>은 카메라에서 지금 지점까지 오는 동안 바운스마다 곱해 온 가중치(f·cos/p)의 누적값이다. 경로가 재질을 하나 거칠 때마다 곱으로 깎이는, "여기까지 살아남은 비율"로 읽으면 된다.
</p>

<div class="code-block"><span class="code-lang">HLSL — PathTracingCore.ush (UE 5.8)</span><span class="cm">// NEE 기여 = throughput × (L/p_light) × f × w_MIS × visibility</span>
<span class="ty">FMaterialEval</span> MaterialEval = <span class="fn">EvalMaterial</span>(-PathState.Ray.Direction, LightSample.Direction, Payload, ...);
<span class="ty">float3</span> LightContrib = PathState.PathThroughput * LightSample.RadianceOverPdf
                    * MaterialEval.Weight * MaterialEval.Pdf;
<span class="kw">if</span> (MISMode == <span class="num">2</span>)
{
	LightContrib *= <span class="fn">MISWeightPower</span>(LightSample.Pdf, MaterialEval.Pdf);	<span class="cm">// 08장</span>
}
LightContrib *= <span class="fn">TraceTransparentVisibilityRay</span>(LightRay, ...);	<span class="cm">// 그림자 ray는 가시성만 확인</span>
PathState.<span class="fn">AccumulateRadiance</span>(LightContrib);</div>
</div>

<div class="research-post">
<span class="section-eyebrow">08 — MIS</span>
</div>

# 두 전략을 섞기: Multiple Importance Sampling

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
이제 방향을 뽑는 전략이 두 개가 됐다. BRDF를 닮은 샘플링(04~05장)과 라이트를 닮은 샘플링(07장). 문제는 어느 쪽도 항상 이기지 못한다는 것이다.
</p>

<div class="vs-grid">
<div class="vs-card">
<h4>라이트 샘플링이 이기는 장면</h4>
<p>작은 라이트 + 거친 표면. BRDF 로브(BRDF가 반사를 몰아주는 방향 다발)가 넓어서 아무 데나 쏘면 라이트를 못 맞힌다. 라이트를 직접 겨냥하면 한 발로 끝. 반대로 BRDF 샘플링은 노이즈 폭발.</p>
</div>
<div class="vs-card">
<h4>BRDF 샘플링이 이기는 장면</h4>
<p>큰 라이트(하늘) + 매끈한 표면. 거울 로브는 좁아서 반사 방향만 의미가 있는데, 라이트 샘플링은 거대한 하늘 아무 데나 겨냥한다. 로브 밖을 뽑으면 기여가 0이라 낭비고, 어쩌다 로브 안을 뽑으면 그 방향의 p가 작아서 f/p가 폭발한다.</p>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
한 장면 안에 두 상황이 공존하므로(거친 바닥과 매끈한 주전자), 둘 다 쏘고 합쳐야 한다. 그런데 단순히 두 추정치를 더하면 빛을 이중으로 세고, 절반씩 평균내면 각 전략이 망하는 영역의 폭발적 분산이 절반만 줄어든 채 그대로 들어온다. Veach(1995)의 해법 MIS<span class="fn-note"><input type="checkbox" id="fn-mis" class="fn-toggle"><label for="fn-mis" class="fn-ref">7</label><span class="fn-body"><strong>MIS(multiple importance sampling):</strong> 같은 적분을 겨냥하는 여러 샘플링 전략의 결과를, 샘플마다 "이 방향은 어느 전략이 더 잘 뽑는가"의 비율로 가중해 합치는 기법. Eric Veach의 1995년 논문과 박사학위 논문에서 정리됐고, 이 업적으로 Veach는 2014년 아카데미 기술상을 받았다.</span></span>는 샘플마다 가중치를 <strong>PDF들의 비율</strong>로 정한다. 어떤 방향에 대해 두 전략의 PDF가 p₁, p₂라면 전략 1의 샘플에 w₁ = p₁²/(p₁²+p₂²)를 곱한다(파워 휴리스틱). 내가 잘 뽑는 방향은 내가 책임지고(w≈1), 상대가 잘 뽑는 방향에서 내가 우연히 뽑은 폭발 샘플은 w≈0으로 눌러 버린다. 두 전략의 가중치 합이 방향마다 정확히 1이라 이중 계산도 없다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="MIS 가중치가 방향별로 책임을 나누는 방식">
<rect x="10" y="10" width="740" height="310" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="38" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">두 전략의 PDF (같은 방향 축 위에서)</text>
<path d="M60 168 C 150 164, 190 62, 270 58 C 350 62, 410 150, 700 168" fill="none" stroke="#3b82c4" stroke-width="2.5"/>
<text x="120" y="90" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#3b82c4" font-weight="700">p_BSDF: 로브를 따라 넓게</text>
<path d="M60 169 L480 168 C 500 164, 506 42, 520 40 C 534 42, 540 164, 560 168 L700 169" fill="none" stroke="#b45309" stroke-width="2.5"/>
<text x="545" y="60" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#b45309" font-weight="700">p_light: 광원 방향에 좁고 높게</text>
<line x1="60" y1="170" x2="700" y2="170" stroke="#4b5563" stroke-width="1.5"/>
<text x="30" y="215" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">MIS 가중치 w (합이 항상 1)</text>
<line x1="60" y1="235" x2="700" y2="235" stroke="#9aa3b5" stroke-width="1" stroke-dasharray="4 4"/>
<text x="705" y="239" font-family="Segoe UI, sans-serif" font-size="11" fill="#9aa3b5">w=1</text>
<line x1="60" y1="295" x2="700" y2="295" stroke="#4b5563" stroke-width="1.5"/>
<path d="M60 236 L440 238 C 480 242, 495 288, 520 292 C 545 288, 560 244, 700 238" fill="none" stroke="#3b82c4" stroke-width="2.5"/>
<path d="M60 294 L440 292 C 480 288, 495 242, 520 238 C 545 242, 560 286, 700 292" fill="none" stroke="#b45309" stroke-width="2.5"/>
<text x="130" y="258" font-family="Segoe UI, sans-serif" font-size="12" fill="#3b82c4" font-weight="700">여기는 BSDF 샘플이 책임 (w_BSDF ≈ 1)</text>
<text x="470" y="225" font-family="Segoe UI, sans-serif" font-size="12" fill="#b45309" font-weight="700">광원 근처는 라이트 샘플이 책임</text>
</svg>
<div class="scene-cap">위: 같은 방향 축 위에 두 전략의 PDF를 겹쳐 그린 것. 아래: 파워 휴리스틱이 만드는 가중치. 어떤 방향이든 그 방향을 더 잘 뽑는(PDF가 큰) 전략의 가중치가 1에 붙고 상대는 0으로 내려가며, 둘의 합은 항상 정확히 1이다. 각 전략이 약한 영역에서 우연히 뽑은 폭발 샘플(작은 p로 나눈 큰 값)은 0에 가까운 가중치로 눌린다.</div>
</div>

<div class="code-block"><span class="code-lang">HLSL — MonteCarlo.ush (UE 5.8)</span><span class="cm">// 파워 휴리스틱(지수 2). 소박한 Pdf²/(Pdf²+OtherPdf²) 대신</span>
<span class="cm">// min/max 비율로 재구성: 0/0, Inf/Inf에 안전하고 w(a,b)+w(b,a)=1이 정확히 보장된다</span>
<span class="kw">float</span> <span class="fn">MISWeightPower</span>(<span class="kw">float</span> Pdf, <span class="kw">float</span> OtherPdf)
{
	<span class="kw">float</span> X = <span class="fn">min</span>(Pdf, OtherPdf) / <span class="fn">max</span>(Pdf, OtherPdf);
	<span class="kw">float</span> Y = Pdf == OtherPdf ? <span class="num">1.0</span> : X;
	<span class="kw">float</span> M = <span class="fn">rcp</span>(<span class="num">1.0</span> + Y * Y);
	<span class="kw">return</span> Pdf > OtherPdf ? M : <span class="num">1.0</span> - M;
}</div>

<p style="color:var(--text2);line-height:1.85;">
반경 0의 포인트 라이트처럼 PDF가 무한대인 싱귤러 라이트도 이 재정식화 덕분에 자연스럽게 w=1이 된다. 패스 트레이서의 실제 흐름은 매 바운스 <strong>양쪽에서 한 번씩, 두 번 가중</strong>한다. 라이트 샘플 쪽은 07장 코드의 <code>MISWeightPower(LightSample.Pdf, MaterialEval.Pdf)</code>. BSDF 샘플 쪽은 진행 방향을 정한 뒤 그 방향에서 보이는 라이트들을 ray를 추가로 쏘지 않고 수식으로 검사해(<code>TraceLight</code>) <code>MISWeightPower(MaterialSample.Pdf, LightResult.Pdf * LightPickPdf)</code>를 곱한다. 모드는 <code>r.PathTracing.MISMode</code>(기본 2 = 양쪽 다)로 바꿔볼 수 있는데, 1(라이트만)로 두면 거울 반사 속 라이트가 사라지고 0(BSDF만)으로 두면 작은 라이트의 직접광이 노이즈 범벅이 되는 것으로 위 표의 두 장면을 직접 확인할 수 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
MIS는 전략이 꼭 둘일 필요도, 샘플을 여러 발 쏠 필요도 없다. 스카이라이트 샘플링은 <strong>휘도 CDF 텍스처 샘플링과 코사인 반구 샘플링을 50:50으로 섞은 뒤 한 발만 쏘고</strong>, 가중을 혼합 PDF로 처리한다: <code>RayWeight = 1/lerp(CosinePdf, SkyLightPdf, 0.5)</code>. 이것이 원샘플 MIS다. 멀티 로브 재질(디퓨즈 + 스페큘러 + 코트)도 같은 수학이다. 로브 하나를 확률적으로 고르고, 반환 PDF를 <code>AddLobeWithMIS</code>로 "로브 선택 확률 × 로브 PDF"의 합(혼합 PDF)으로 만든다. 여기서는 밸런스 휴리스틱(<code>MISWeightBalanced</code>)이 쓰인다. 스카이라이트에는 보정 옵션도 하나 있다. <code>r.PathTracing.MISCompensation</code>(기본 1)은 스카이 CDF에서 평균 휘도를 빼서, BSDF 샘플링이 어차피 잘 잡는 저휘도 하늘에 라이트 샘플을 낭비하지 않게 한다. MIS 짝이 있어야만 쓸 수 있는 공격적 튜닝이다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">09 — 러시안 룰렛</span>
</div>

# 무한히 튀는 빛을 어디서 끊나: 러시안 룰렛과 파이어플라이

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
빛은 무한히 튀는데 경로는 언젠가 끊어야 한다. "5바운스에서 자른다"는 5바운스 이후의 에너지를 통째로 버리는 것이라, 어둡게 왜곡된다(바이어스). 불편성을 지키면서 끊는 방법이 러시안 룰렛이다. 매 바운스에서 확률 p로만 계속 진행하고(여기서 p는 PDF가 아니라 "계속 갈 확률"이다), <strong>살아남으면 기여를 1/p배로 부풀린다.</strong> 기대값은 p × (X/p) + (1-p) × 0 = X로 정확히 보존된다. 열 명 중 세 명만 계속 일하게 하는 대신 그 세 명의 결과를 10/3배로 쳐 주는 것과 같다. 개별 경로는 일찍 끊기거나 과대평가되지만, 평균은 무한 바운스의 정답과 일치한다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="러시안 룰렛이 경로를 확률적으로 끊고 생존자를 보정하는 방식">
<rect x="10" y="10" width="740" height="310" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="70" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">경로 10개</text>
<text x="330" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#b45309">룰렛: 계속 갈 확률 p = 0.3</text>
<line x1="390" y1="50" x2="390" y2="285" stroke="#b45309" stroke-width="1.5" stroke-dasharray="6 4"/>
<g stroke="#9aa3b5" stroke-width="2">
<line x1="70" y1="62" x2="380" y2="62"/><line x1="70" y1="108" x2="380" y2="108"/><line x1="70" y1="131" x2="380" y2="131"/><line x1="70" y1="177" x2="380" y2="177"/><line x1="70" y1="200" x2="380" y2="200"/><line x1="70" y1="223" x2="380" y2="223"/><line x1="70" y1="269" x2="380" y2="269"/>
</g>
<g stroke="#0a8f72" stroke-width="2">
<line x1="70" y1="85" x2="380" y2="85"/><line x1="70" y1="154" x2="380" y2="154"/><line x1="70" y1="246" x2="380" y2="246"/>
</g>
<g fill="#c0392b" font-family="Segoe UI, sans-serif" font-size="14" font-weight="700">
<text x="397" y="67">✕</text><text x="397" y="113">✕</text><text x="397" y="136">✕</text><text x="397" y="182">✕</text><text x="397" y="205">✕</text><text x="397" y="228">✕</text><text x="397" y="274">✕</text>
</g>
<defs><marker id="mc9ArrG" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#0a8f72"/></marker></defs>
<g stroke="#0a8f72" stroke-width="4.5">
<line x1="400" y1="85" x2="660" y2="85" marker-end="url(#mc9ArrG)"/>
<line x1="400" y1="154" x2="660" y2="154" marker-end="url(#mc9ArrG)"/>
<line x1="400" y1="246" x2="660" y2="246" marker-end="url(#mc9ArrG)"/>
</g>
<text x="480" y="72" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#0a8f72" font-weight="700">생존한 3개는 기여 × 1/0.3</text>
<text x="70" y="305" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#4b5563">기대값: 0.3 × (X / 0.3) + 0.7 × 0 = X. 평균은 끊기 전과 정확히 같다</text>
</svg>
<div class="scene-cap">경로 10개가 확률 30%의 관문을 지난다. 7개는 여기서 끝나고 3개만 계속 가는 대신, 살아남은 경로의 기여를 1/0.3 = 3.3배로 부풀린다. 일을 시키는 경로 수는 줄었는데 평균은 정확히 보존되므로, 무한히 튀는 빛을 유한한 계산으로 왜곡 없이 끊을 수 있다. 대가는 분산이다. 살아남은 경로가 3.3배로 뻥튀기되는 만큼 값의 널뜀은 커진다.</div>
</div>

<div class="code-block"><span class="code-lang">HLSL — PathTracingCore.ush (UE 5.8)</span><span class="cm">// 지속 확률 = 이번 바운스에서 잃는 에너지 비율. sqrt로 완화해서 첫 바운스부터 적용해도 안전</span>
<span class="kw">float</span> ContinuationProb = <span class="fn">sqrt</span>(<span class="fn">saturate</span>(
	<span class="fn">max3</span>(NextPathThroughput.x, NextPathThroughput.y, NextPathThroughput.z) /
	<span class="fn">max3</span>(PathState.PathThroughput.x, PathState.PathThroughput.y, PathState.PathThroughput.z)));
<span class="kw">if</span> (ContinuationProb &lt; <span class="num">1</span>)
{
	<span class="kw">float</span> RussianRouletteRand = RandSample.w;
	<span class="kw">if</span> (RussianRouletteRand >= ContinuationProb)
	{
		<span class="kw">return</span> <span class="kw">false</span>;	<span class="cm">// 확률적으로 경로 종료</span>
	}
	PathState.PathThroughput = NextPathThroughput / ContinuationProb;	<span class="cm">// 생존자는 1/p 보정</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
확률의 설계가 눈여겨볼 부분이다. 절대 밝기가 아니라 <strong>이번 바운스에서 에너지가 얼마나 깎였는지의 비율</strong>(대략 재질 알베도)을 쓴다. 흰 벽에서는 p≈1이라 거의 안 끊기고, 어두운 재질에서만 공격적으로 끊는다. 주석에 따르면 sqrt는 종료를 완화해 경로를 조금 더 살리는 장치로, 이 덕분에 "3바운스 이후부터 룰렛 시작" 같은 지연 없이 첫 바운스부터 켠다. GPU Lightmass에는 이 코드가 주석까지 글자 그대로 복제되어 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
러시안 룰렛의 1/p 보정은 몬테카를로의 고질병 하나를 다시 보여준다. <strong>p가 작은 사건을 밟으면 1/p가 폭발한다.</strong> 화면에서 이 폭발은 혼자 새하얀 픽셀, 파이어플라이<span class="fn-note"><input type="checkbox" id="fn-firefly" class="fn-toggle"><label for="fn-firefly" class="fn-ref">8</label><span class="fn-body"><strong>파이어플라이(firefly):</strong> 주변보다 수백 배 밝은 고립 픽셀. 확률은 낮은데 기여가 거대한 샘플(작은 PDF로 뽑힌 강한 경로)이 f/p 보정으로 증폭되어 생긴다. 반딧불이처럼 띄엄띄엄 반짝여서 붙은 이름. 평균이 수렴하려면 아주 오래 걸리므로 실전에서는 클램프로 눌러 버리는 경우가 많다.</span></span>로 나타난다. 수학적으로는 시간이 지나면 평균에 흡수될 정직한 샘플이지만, 그때까지 수만 프레임이 걸릴 수 있다. 그래서 엔진 도처에 "분산을 사고 바이어스를 파는" 거래가 심어져 있다.
</p>

<table class="data-table">
<tr><th>장치</th><th>위치 (UE 5.8)</th><th>내용</th></tr>
<tr><td><code>MaxPathIntensity</code></td><td><code>AccumulateRadiance</code> (PathTracingCore.ush)</td><td>간접 경로 기여를 색 보존 방식으로 클램프. 주석이 대가를 명시한다: "upper bound on variance ... at the expense of bias"</td></tr>
<tr><td><code>E.y *= 0.995</code></td><td>리플렉션 프리필터 (ReflectionEnvironmentShaders.usf)</td><td>GGX inverse CDF가 발산하는 꼬리 끝을 잘라 극단 방향 샘플을 차단</td></tr>
<tr><td><code>GGX_IMPORTANT_SAMPLE_BIAS 0.1</code></td><td>SSR 디노이저 입력 (SSDPublic.ush)</td><td>1 SPP 신호에서 GGX 꼬리를 10%나 잘라냄. 디노이저가 받기 좋은 신호를 위해 반사를 살짝 좁히는 대가</td></tr>
<tr><td><code>GGXSamplingBias</code></td><td>Lumen 리플렉션 (LumenReflections.usf)</td><td>같은 발상. <code>E.y *= 1 - GGXSamplingBias</code></td></tr>
<tr><td><code>MaxShadingWeight</code> · <code>log2(Lum+1)</code></td><td>MegaLights</td><td>RIS 웨이트 클램프와 지각 가중. 숨은 강한 라이트 주변의 노이즈 억제</td></tr>
</table>

<p style="color:var(--text2);line-height:1.85;">
전부 같은 거래의 변형이다. 불편성(언젠가 정답)을 조금 포기하고, 지금 당장의 노이즈를 산다. 오프라인 레퍼런스가 목적이면 이 손잡이들을 풀고, 실시간 1 SPP가 목적이면 조인다. <a href="/denoising">디노이징 글</a>에서 다룬 디노이저도 크게 보면 같은 축 위에 있는 가장 큰 거래다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">10 — 실시간</span>
</div>

# 실시간 렌더러의 몬테카를로: 수학은 같고 예산만 다르다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
패스 트레이서는 수천 샘플을 쓸 수 있지만 실시간은 픽셀당 한두 발이 전부다. 그런데도 리플렉션 프리필터, SSR, Lumen, MegaLights의 코드를 열면 전부 같은 3단 구조가 반복된다. <strong>균등 난수를 만들고(06장), 임포턴스 분포로 워프하고(03~05장), 기여를 PDF로 복원한다(02장).</strong> 다른 것은 각 단계를 어떤 예산으로 감당하느냐뿐이다.
</p>

<table class="data-table">
<tr><th>소비처</th><th>① 균등 난수</th><th>② 워프(임포턴스 샘플)</th><th>③ 기여/PDF 복원</th></tr>
<tr><td>리플렉션·스카이 프리필터</td><td>Hammersley (고정 시퀀스)</td><td><code>ImportanceSampleGGX</code></td><td>PDF → 입체각 → <strong>밉 선택</strong>으로 치환</td></tr>
<tr><td>SSR</td><td>Hammersley16 + PCG 스크램블</td><td><code>ImportanceSampleVisibleGGX</code></td><td>f/p 보정을 컴포짓의 EnvBRDF LUT로 미룸</td></tr>
<tr><td>Lumen 리플렉션</td><td>블루노이즈</td><td><code>ImportanceSampleVisibleGGX</code></td><td>PDF의 역수를 ray <strong>콘 각</strong>으로 재활용</td></tr>
<tr><td>Lumen 스크린 프로브</td><td>블루노이즈 텍셀 지터</td><td>PDF 비례 <strong>레이 격자 재분할</strong></td><td>레이가 대표하는 입체각 면적비로 가중</td></tr>
<tr><td>MegaLights</td><td>블루노이즈 + 층화(구간을 나눠 고르게 뽑기)</td><td>저수지 선택 P = w/ΣW</td><td>W = ΣW/w, (1/M)Σ f·W (RIS 표준형)</td></tr>
<tr><td>RT 면광원·스카이라이트</td><td>FRandomSequence</td><td>spherical rect · 콘 · CDF 트리</td><td>1/PDF 곱, 스카이는 원샘플 MIS</td></tr>
</table>

<p style="color:var(--text2);line-height:1.85;">
<strong>프리필터의 밉 트릭</strong>부터 보자. 리플렉션 캡처의 GGX 컨볼루션은 레퍼런스 1024샘플 자리를 32~64샘플로 때우는데, 비결이 PDF의 재해석이다. 샘플 하나가 대표하는 입체각은 1/(N × PDF)다. PDF가 낮은 방향(드물게 뽑히는 방향)일수록 넓은 영역을 혼자 대표하므로, <strong>그 넓이에 맞는 위쪽(블러된) 밉에서 읽는다.</strong> 노이즈가 될 분산을 밉맵의 블러(바이어스)로 교환하는 filtered importance sampling이다. 대조가 되는 반례도 같은 파일에 있다. 스카이라이트의 디퓨즈 SH(<a href="/spherical-harmonics">구면 조화 함수</a>) 적분은 임포턴스 샘플링 없이 <strong>균등 64샘플</strong>로 끝낸다. 코사인 로브 × 하늘빛은 충분히 저주파라서 그걸로 이미 정확하기 때문이다. 임포턴스 샘플링은 피적분 함수가 뾰족할 때 필요한 도구지, 만능 기본값이 아니다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong><a href="/lumen">Lumen</a> 스크린 프로브</strong>는 임포턴스 샘플링을 난수 워프가 아니라 자료구조로 구현한 경우다. 프로브의 옥타헤드럴(구면을 정사각형 텍스처에 펴 바르는 매핑) ray 격자는 고정 개수(8×8)인데, 방향마다 두 개의 PDF를 곱해 우선순위를 매긴다. 프로브가 대표하는 픽셀들의 코사인 로브를 SH로 누적한 <strong>BRDF PDF</strong>, 그리고 지난 프레임 라디언스를 재투영한 <strong>라이팅 PDF</strong>다. 이상적 목표 분포가 f×L의 곱이라는 교과서 명제가 코드에서 문자 그대로 <code>PDF *= LightingPDFScale</code>로 나타난다. 그리고 워프 대신 <strong>재배분</strong>을 한다. PDF가 문턱 미만인 ray 3개를 죽이고 그 예산으로 최고 PDF ray 하나를 2×2로 쪼갠다. 적분할 때는 쪼개진 ray가 1/4 입체각을 대표하므로 면적비로 가중한다. 연속 PDF 나눗셈의 이산 버전이다. 방어 코드도 배울 점이다. 히스토리 라이팅은 틀릴 수 있으므로(가려져 있다가 이번 프레임에 새로 드러난 디스오클루전 영역), BRDF가 살린 ray는 라이팅이 어두워도 죽이지 않는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong><a href="/megalights">MegaLights</a></strong>는 이산 임포턴스 샘플링의 최신형이다. 뽑고 싶은 목표 분포(target PDF)는 "그림자만 뺀 그 라이트의 실제 셰이딩 휘도"인데, 이건 CDF를 미리 만들 수 없으니 후보를 순회하며 저수지(reservoir) 하나를 확률적으로 갱신하는 weighted reservoir sampling으로 뽑는다. 선택된 라이트의 보정 계수가 <code>W = WeightSum / w</code>이고 최종 추정량이 (1/M)Σ f·W, RIS(resampled importance sampling)의 표준형이다. 셰이딩 함수 자체를 target PDF로 쓰니 "p가 f를 닮게"의 극한이고, 남는 잔차는 그림자뿐이라 ray는 가시성 확인에만 쓴다. 이 저수지 수학이 시간·공간 재사용으로 일반화된 것이 <a href="/restir">ReSTIR</a>이다. 실제로 <code>LumenReSTIRGather.usf</code>의 저수지 주석에는 "wNew must be TargetPDF / OriginalPDF"라고 RIS 웨이트 정의가 실명으로 박혀 있다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="weighted reservoir sampling이 후보 라이트 중 하나를 확률적으로 고르는 과정">
<rect x="10" y="10" width="740" height="280" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">후보 라이트를 하나씩 스트리밍 (막대 = 목표 가중치 w, 대략의 셰이딩 기여)</text>
<g fill="#3b82c4">
<rect x="70" y="110" width="24" height="20" /><rect x="150" y="75" width="24" height="55"/><rect x="230" y="100" width="24" height="30"/><rect x="310" y="40" width="24" height="90" fill="#b45309"/><rect x="390" y="105" width="24" height="25"/><rect x="470" y="85" width="24" height="45"/><rect x="550" y="65" width="24" height="65"/><rect x="630" y="95" width="24" height="35"/>
</g>
<line x1="50" y1="130" x2="710" y2="130" stroke="#4b5563" stroke-width="1.5"/>
<g font-family="Segoe UI, sans-serif" font-size="11.5" fill="#4b5563">
<text x="72" y="148">w₁</text><text x="152" y="148">w₂</text><text x="232" y="148">w₃</text><text x="312" y="148">w₄</text><text x="392" y="148">w₅</text><text x="472" y="148">w₆</text><text x="552" y="148">w₇</text><text x="632" y="148">w₈</text>
</g>
<g stroke="#9aa3b5" stroke-width="1" stroke-dasharray="3 3">
<line x1="82" y1="152" x2="330" y2="195"/><line x1="162" y1="152" x2="340" y2="195"/><line x1="242" y1="152" x2="350" y2="195"/><line x1="322" y1="152" x2="360" y2="195"/><line x1="402" y1="152" x2="380" y2="195"/><line x1="482" y1="152" x2="390" y2="195"/><line x1="562" y1="152" x2="400" y2="195"/><line x1="642" y1="152" x2="410" y2="195"/>
</g>
<rect x="290" y="195" width="180" height="58" rx="8" fill="none" stroke="#0a8f72" stroke-width="2"/>
<text x="305" y="219" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#0a8f72" font-weight="700">저수지: 라이트 1개만 보관</text>
<text x="305" y="240" font-family="Segoe UI, sans-serif" font-size="12" fill="#0a8f72">교체 확률 = wᵢ / (지금까지의 ΣW)</text>
<text x="490" y="224" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#4b5563" font-weight="700">→ 뽑힌 라이트 (예: w₄)</text>
<text x="490" y="243" font-family="Segoe UI, sans-serif" font-size="12.5" fill="#4b5563">보정 계수 W = ΣW / w₄</text>
<text x="30" y="278" font-family="Segoe UI, sans-serif" font-size="12" fill="#4b5563">CDF를 미리 만들지 않고도, 결과는 "w에 비례해 뽑은 것"과 같다</text>
</svg>
<div class="scene-cap">weighted reservoir sampling의 한 픽셀. 후보 라이트를 하나씩 지나가면서 "들고 있는 하나"를 새 후보의 가중치 비율로 확률적으로 교체하면, 전부 보고 난 뒤에는 목표 가중치에 비례해 뽑은 것과 같아진다. 07장의 라이트 선택은 CDF 배열을 미리 만들어 이진 탐색했지만, 여기는 목표 가중치가 픽셀마다 달라 미리 만들 수 없으므로 스트리밍으로 뽑는 것이다. 뽑힌 라이트에는 1/p 대신 보정 계수 W를 곱하며, 이것이 RIS다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 실시간의 N이 어디서 오는지를 짚어야 한다. 픽셀당 1 SPP로 쏘고도 그림이 되는 이유는 <strong>이웃 픽셀과 지난 프레임들이 N을 대신하기 때문</strong>이다. 블루노이즈로 오차를 고주파에 몰아 두면(06장), <a href="/temporal-reprojection-rejection">시간축 누적</a>과 <a href="/denoising">디노이저</a>가 시공간 평균으로 노이즈를 지운다. 실시간 렌더러 전체가 하나의 분산 처리된 몬테카를로 적분기인 셈이다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">정리</span>
</div>

# 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
한 문장으로 압축하면 이렇다. <strong>렌더링 방정식의 적분은 피적분 함수가 재귀 콜백이고 차원이 폭발해서 공식으로도 격자로도 못 풀기 때문에, 무작위 샘플의 평균 (1/N)Σ f/p로 추정한다. p는 무엇이든 평균은 정답에 수렴하므로(불편성), 남는 싸움은 분산이고, 그 핵심 무기가 p를 f와 닮게 고르는 임포턴스 샘플링이다.</strong> UE 5.8에서 이 수학은 균등 난수 E를 받아 float4(방향, PDF)를 돌려주는 MonteCarlo.ush의 함수들, 라이트를 직접 겨냥하는 NEE, 두 전략을 PDF 비율로 섞는 MIS, 경로를 1/p 보정과 함께 왜곡 없이 끊는 러시안 룰렛으로 구현되어 있고, 실시간 기법들은 같은 구조에서 N만 시공간 이웃으로 대체한다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">(1/N) Σ f/p</div>
<div class="card-title">나누기가 전부다</div>
<div class="card-desc">자주 뽑히는 곳은 그만큼 나눠서 목소리를 줄인다. 이 보정 덕분에 어떤 p를 써도 평균이 정답이고, 그래서 p를 마음대로 고를 자유가 생긴다. 노이즈는 오차가 아니라 아직 안 끝난 평균이다.</div>
</div>
<div class="card teal">
<div class="card-label">p ∝ f</div>
<div class="card-title">닮을수록 소거된다</div>
<div class="card-desc">Lambert + 코사인 샘플링은 Weight가 BaseColor만 남고, GGX + VNDF는 F·G_SmithL만 남는다. 임포턴스 샘플링의 품질은 "f/p에 뭐가 남았나"로 판별할 수 있다.</div>
</div>
<div class="card gold">
<div class="card-label">1/√N</div>
<div class="card-title">샘플 4배 = 노이즈 절반</div>
<div class="card-desc">샘플 수로 노이즈를 잡는 것은 이렇게 비싸다. 그래서 저불일치 시퀀스로 샘플의 질을 올리고, NEE·MIS로 분산을 줄이고, 클램프로 바이어스를 사고, 최후에는 디노이저를 부른다.</div>
</div>
<div class="card purple">
<div class="card-label">float4(dir, pdf)</div>
<div class="card-title">PDF는 절차의 속성이다</div>
<div class="card-desc">같은 방향도 면적을 뽑았는지 입체각을 뽑았는지에 따라 PDF가 다르다. UE의 샘플링 API가 방향과 PDF를 한 몸으로 반환하는 것은 이 실수를 구조적으로 막는 설계다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
핵심 숫자들만 모아 두자. 몬테카를로 오차 O(1/√N)와 격자 구적 O(1/N<sup>2/d</sup>)의 교차, 코사인 샘플링의 inverse CDF cosθ = √E, GGX의 cosθ = √((1-E)/(1+(a²-1)E)), 하프벡터→반사방향 PDF 변환 계수 1/(4·VoH), 파워 휴리스틱 지수 2, 프리필터 샘플 수 32~64(레퍼런스 1024), 러시안 룰렛 확률 √(에너지 잔존비), TSR 지터 샘플 수 8→소수 올림, 블루노이즈 텍스처 128×128×64. 이 글의 렌즈로 다시 읽으면 <a href="/gpu-lightmass">GPU Lightmass</a>는 이 적분기를 텍셀마다 돌려 굽는 시스템이고, <a href="/restir">ReSTIR</a>는 f/p의 p를 이웃과 과거에서 빌려오는 시스템이며, <a href="/denoising">디노이저</a>는 부족한 N을 시공간에서 끌어오는 시스템이다. 전부 한 수식의 변주다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card blue">
<div class="card-label">토대 문헌</div>
<div class="card-title">이론</div>
<div class="card-desc">Kajiya, "The Rendering Equation" (SIGGRAPH 1986); <a href="https://graphics.stanford.edu/papers/veach_thesis/">Veach, "Robust Monte Carlo Methods for Light Transport Simulation"</a> (박사학위 논문 1997, MIS·러시안 룰렛·경로 적분 정식화); Veach &amp; Guibas, "Optimally Combining Sampling Techniques" (SIGGRAPH 1995); <a href="https://pbr-book.org/4ed/Monte_Carlo_Integration">PBRT 4th ed. ch.2 "Monte Carlo Integration"</a> · <a href="https://pbr-book.org/4ed/Sampling_and_Reconstruction">ch.8 "Sampling and Reconstruction"</a>.</div>
</div>
<div class="card teal">
<div class="card-label">샘플링 기법</div>
<div class="card-title">GGX · VNDF · 시퀀스</div>
<div class="card-desc">Walter et al. 2007 (GGX 샘플링); <a href="https://jcgt.org/published/0007/04/01/">Heitz 2018, "Sampling the GGX Distribution of Visible Normals"</a>; <a href="https://gpuopen.com/download/publications/Bounded_VNDF_Sampling_for_Smith-GGX_Reflections.pdf">Eto &amp; Tokuyoshi 2023, "Bounded VNDF Sampling"</a>; Dupuy &amp; Benyoub 2023, "Sampling Visible GGX Normals with Spherical Caps"; Ureña et al. 2013, "An Area-Preserving Parametrization for Spherical Rectangles"; <a href="https://developer.nvidia.com/blog/rendering-in-real-time-with-spatiotemporal-blue-noise-textures-part-1/">Wolfe et al. 2022, "Spatiotemporal Blue Noise Masks"</a>; Ahmed et al., "SZ Sequences" (SIGGRAPH Asia 2025); Karis 2013, "Real Shading in Unreal Engine 4" (split-sum 프리필터).</div>
</div>
<div class="card gold">
<div class="card-label">엔진 소스</div>
<div class="card-title">언리얼엔진 5.8</div>
<div class="card-desc"><code>MonteCarlo.ush</code>, <code>SobolRandom.ush</code>, <code>BlueNoise.ush</code>, <code>RandomPCG.ush</code>, <code>PathTracing/PathTracingCore.ush</code>, <code>PathTracing/Utilities/PathTracingRandomSequence.ush</code>, <code>PathTracing/Light/*</code>, <code>PathTracing/Material/*</code>, <code>RectLight.ush</code>, <code>SSRT/SSRTReflections.usf</code>, <code>ReflectionEnvironmentShaders.usf</code>, <code>Lumen/LumenScreenProbeImportanceSampling.usf</code>, <code>MegaLights/*</code>, <code>SceneVisibility.cpp</code>, <code>PathTracing.cpp</code>. 이 글의 모든 코드 인용의 1차 출처.</div>
</div>
<div class="card purple">
<div class="card-label">이 블로그</div>
<div class="card-title">이어 읽기</div>
<div class="card-desc">이 글이 바닥을 깐 글들: <a href="/d8c73243c492ed7b5f44b70936cfe4521669ad34">렌더링 방정식</a>(적분의 정체), <a href="/brdf">BRDF</a>(f의 정체), <a href="/gpu-lightmass">GPU Lightmass</a>·<a href="/cpu-lightmass">CPU Lightmass</a>(오프라인 적분), <a href="/restir">ReSTIR</a>(RIS의 일반화), <a href="/denoising">디노이징</a>(부족한 N의 보충), <a href="/raytracing-gi">Ray Traced GI</a>(이 수학이 실시간에서 겪은 흥망), <a href="/taa">TAA</a>·<a href="/tsr">TSR</a>(Halton 지터의 소비처).</div>
</div>
</div>
</div>
