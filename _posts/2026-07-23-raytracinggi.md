---
layout: post
title: "Ray Traced GI: 정답은 알려져 있는데 왜 아무도 그렇게 안 하는가 — 렌더링 방정식에서 발산·히트 셰이딩·노이즈라는 세 벽, 그리고 UE에서의 흥망까지"
icon: paper
permalink: raytracing-gi
categories: Rendering
tags: [ComputerGraphics, Rendering, RayTracing, GlobalIllumination, RTGI, Lumen, DDGI, Divergence, Denoising, UnrealEngine]
excerpt: "간접광의 정답은 40년 전부터 알려져 있다 — 렌더링 방정식을 광선으로 푸는 것이다. 오프라인 렌더러는 실제로 그렇게 하고, GPU에는 이제 전용 하드웨어까지 있다. 그런데 UE 5.8의 간접광 메뉴에서 '독립 Ray Traced GI'는 아예 사라졌고, 순수한 per-pixel RTGI로 출하된 게임은 손에 꼽는다. 이 글은 그 이유를 해부한다 — 디퓨즈 바운스가 만드는 광선 비간섭성과 GPU 발산(SER 재정렬만으로 3.7×가 나오는 역설), 히트 지점 머티리얼 평가의 비용(Hit Lighting 11.54ms vs Surface Cache 2.44ms), 1spp 노이즈와 디노이저 의존이라는 세 벽을 검증된 1차 소스로 짚고, UE 4.22 도입→4.27 문서의 자백→5.8 완전 제거의 타임라인을 로컬 소스 물증으로 추적한다. 그리고 살아남은 전략들(DDGI·Lumen·ReSTIR)이 각각 어느 벽을 우회했는지, '풀 RTGI'로 유명한 Metro Exodus EE조차 실은 프로브 하이브리드였다는 반전까지 다룬다. 이 블로그의 GI 글들을 하나로 묶는 글이다."
back_color: "#ffffff"
img_name: "raytracing-gi-core-sketch-white.webp"
toc: false
show: true
new: true
series: -1
index: 29
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - "GPU에 RT 코어도 있는데 왜 아직도 GI는 프로브·캐시·꼼수 투성이인가?"가 궁금한 분
> - 그림자 레이는 되는데 GI 레이는 왜 유독 느린지 — 광선 종류별 비용 차이의 정체를 알고 싶은 분
> - SER(Shader Execution Reordering)이 왜 하필 GI에서 3.7× 같은 숫자를 내는지, 그 숫자가 무엇을 거꾸로 증명하는지 궁금한 분
> - UE에 있었던 `r.RayTracing.GlobalIllumination`이 언제, 왜 사라졌는지 타임라인이 궁금한 분
> - DDGI·Lumen·ReSTIR가 각각 "풀 RTGI의 어떤 비용"을 피해서 성립하는 기법인지 한 장의 지도로 보고 싶은 분
> - Metro Exodus EE·Cyberpunk Overdrive 같은 '풀 레이 트레이싱' 게임이 실제로 무엇을 타협했는지 궁금한 분
>
> **이 글로 알 수 있는 내용**
>
> - 렌더링 방정식이 요구하는 것과, 그걸 광선으로 정직하게 푸는 RTGI의 원리 (그리고 그게 왜 이론상 정답인지)
> - **벽 ① 발산**: 디퓨즈 바운스 후 광선이 인접 픽셀끼리도 완전히 흩어져 실행 발산·데이터 발산을 동시에 일으키는 구조
> - **벽 ② 히트 셰이딩**: 히트 지점 머티리얼 평가가 왜 지배적 비용인지 — NVIDIA의 공식 권고("GI 레이엔 풀 셰이딩 하지 마라")와 Epic의 실측(11.54ms vs 2.44ms)
> - **벽 ③ 노이즈**: 픽셀당 ~1 광선의 분산, 시간축 누적의 고스팅/지연, "디노이저 없는 RTGI는 없다"는 현실
> - UE 4.22(2019) 도입 → 4.27 문서의 1바운스·고스팅 자백 → 5.0 deprecated → 5.8 완전 제거 — 로컬 소스의 `enum { Disabled, SSGI, Lumen, Plugin }` 물증
> - 살아남은 전략 지도: DDGI(~1ms·노이즈 없음·광선 예산이 해상도와 무관) / Lumen(픽셀당 실효 0.25 광선 + 캐시 + 수 초 전파 지연) / ReSTIR(샘플 재사용)
> - 업계 현실: Metro Exodus EE의 "infinite bounce"가 실은 DDGI 프로브였다는 것, Cyberpunk Overdrive가 쌓은 3층 스택
> - 하드웨어 전망: SER는 발산을 완화하지 제거하지 않는다 — 콘솔(RDNA2)의 구조적 취약점까지

<br>

{% include research-post-style.html %}

<div class="research-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: 정답은 알려져 있다. 메뉴에서는 사라졌다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
간접광 문제의 정답은 40년 전부터 알려져 있다. Kajiya의 렌더링 방정식(1986)이 무엇을 계산해야 하는지 말해주고, 몬테카를로 패스 트레이싱이 그것을 어떻게 계산하는지 말해준다 — <strong>표면 점에서 광선을 쏘고, 부딪힌 곳에서 또 쏘고, 그 빛을 전부 모으면 된다.</strong> 오프라인 렌더러는 실제로 그렇게 하고, 영화가 그 결과물이다. 2018년부터는 GPU에 광선-삼각형 교차를 하드웨어로 푸는 RT 코어까지 실렸다. 그러면 게임의 간접광도 이제 광선으로 정직하게 풀면 되지 않나?
</p>

<p style="color:var(--text2);line-height:1.85;">
현실은 반대로 갔다. UE 4.22(2019)에 있던 독립 기능 <strong>Ray Traced Global Illumination</strong>은 UE 5.8 소스에서 파일 자체가 사라졌고, 간접광 방법을 고르는 enum에는 아예 그런 선택지가 없다. 순수한 per-pixel 레이 트레이싱 GI로 출하된 게임은 손에 꼽으며, '풀 레이 트레이싱'으로 가장 유명한 Metro Exodus Enhanced Edition조차 뜯어보면 다중 바운스를 프로브 그리드로 우회한 하이브리드다. 업계가 실제로 출하한 것은 <a href="/ddgi">프로브(DDGI)</a>, <a href="/lumen">캐시(Lumen)</a>, <a href="/restir">재사용(ReSTIR)</a> — 하나같이 "광선을 정직하게 쏘는 것"을 <em>피하는</em> 기법들이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
왜 정답이 기각됐는가. 이 글은 그 이유를 세 개의 벽으로 해부한다 — <strong>① 발산</strong>(디퓨즈 바운스가 만드는 광선 비간섭성이 GPU의 작동 원리와 정면충돌한다), <strong>② 히트 셰이딩</strong>(광선이 부딪힌 곳의 머티리얼 평가가 비용의 대부분을 차지한다), <strong>③ 노이즈</strong>(픽셀당 한 발의 광선으로는 적분이 수렴하지 않는다). 각 벽을 검증된 1차 소스(NVIDIA·Epic·Khronos 원문)로 짚은 뒤, UE에서의 흥망 타임라인을 로컬 소스 물증으로 추적하고, 살아남은 기법들이 각각 어느 벽을 우회했는지 지도를 그린다. 이 블로그의 GI 글들(<a href="/ddgi">DDGI</a>·<a href="/restir">ReSTIR</a>·<a href="/lumen">Lumen</a>·<a href="/gpu-lightmass">GPU Lightmass</a>·<a href="/denoising">디노이징</a>·<a href="/raytracing-shader">RT 인프라</a>)을 하나로 묶는 글이기도 하다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처와 검증</div>
<p>웹에서 모은 주장 113건 가운데 핵심 25건은 서로 반박을 붙여 <strong>3표 교차 검증</strong>을 거쳤다 — 21건 확인, 4건 반박. 본문 인용은 전부 검증을 통과한 것이고, 반박된 주장은 싣지 않았다. 1차 소스: NVIDIA RTX Best Practices·SER 백서·RTXGI 블로그, Khronos SER 블로그, Epic UE 4.27/5.8 공식 문서, GDC 2024 Cyberpunk 세션 등(하단 참고). UE 5.8 파트는 로컬 소스(<code>D:\UnrealEngine_5_8</code>)에서 파일:라인 단위로 직접 확인했다. 수치의 하드웨어·연도 맥락(2019 RTX 2080 Ti, 2025 RTX 4070 Ti 등)은 본문에 함께 표기한다.</p>
</div>

<span class="section-eyebrow">01 — 원리</span>
</div>

# 렌더링 방정식 → 광선 → 바운스: 왜 이게 정답인가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
출발점을 짧게 못 박자(자세한 유도는 <a href="/gpu-lightmass">GPU Lightmass 글</a>이 다뤘다). 표면 한 점이 눈으로 보내는 빛은 렌더링 방정식이 정의한다 — 그 점이 스스로 내는 빛에, <strong>반구의 모든 방향에서 들어오는 빛 × BRDF × 코사인</strong>을 적분해 더한 것. 문제는 "들어오는 빛" 안에 다른 표면이 반사한 빛, 즉 <strong>간접광</strong>이 들어 있다는 것이다. 방정식이 자기 자신을 참조하므로, 정확히 풀려면 재귀가 필요하다.
</p>

<div class="eq-anno-wrap">
<div class="eq-anno">
<span class="term">
<span class="t-formula"><i>L</i><sub>o</sub>(<i>x</i>, <i>ω</i><sub>o</sub>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 26 2, 52 5 T 97 4" fill="none" stroke="#4338ca" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#4338ca;">나가는 빛<br>= 구하려는 값</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><i>L</i><sub>e</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M4 4 Q 30 6.5, 55 3.5 T 96 5" fill="none" stroke="#d6304a" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#d6304a;">자발광<br>(없으면 0)</span>
</span>
<span class="op">+</span>
<span class="term">
<span class="t-formula"><span style="font-size:1.4em;">∫</span><sub>Ω</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5 Q 28 2.5, 54 5.5 T 97 3.5" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">반구의 모든 방향에<br>대해 적분</span>
</span>
<span class="term">
<span class="t-formula"><i>f</i><sub>r</sub>(<i>x</i>, <i>ω</i><sub>i</sub>, <i>ω</i><sub>o</sub>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4.5 Q 25 7, 50 4 T 97 5.5" fill="none" stroke="#0a8f72" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#0a8f72;">BRDF<br>재질의 반사 특성</span>
</span>
<span class="op">·</span>
<span class="term">
<span class="t-formula"><i>L</i><sub>i</sub>(<i>x</i>, <i>ω</i><sub>i</sub>)</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 27 3, 53 6 T 97 4" fill="none" stroke="#b45309" stroke-width="2.4" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">들어오는 빛 = 다른 표면의 <i>L</i><sub>o</sub><br>여기서 재귀가 생긴다</span>
</span>
<span class="op">·</span>
<span class="term">
<span class="t-formula">cos<i>θ</i></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M4 4 Q 29 6, 55 3.5 T 96 5" fill="none" stroke="#c85a00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#c85a00;">코사인 감쇠<br>비스듬히 오면 약해진다</span>
</span>
<span class="term">
<span class="t-formula">d<i>ω</i><sub>i</sub></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M6 5 Q 40 3, 60 5.5 T 94 4.5" fill="none" stroke="#b07d00" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b07d00;">∫의 짝</span>
</span>
</div>
<div class="formula-note">이 <i>L</i><sub>i</sub> 안에 또 다른 표면의 <i>L</i><sub>o</sub>가 들어 있어서, 닫힌 형태의 해가 없다. 적분값을 알려면 반구에서 방향을 뽑아 광선을 쏘고 평균을 내는 수밖에 없다 — 그 광선이 이 글의 주인공이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
레이 트레이싱 GI는 이 재귀를 광선으로 정직하게 편다. 픽셀의 표면 점에서 반구 방향으로 광선을 쏘고(1차 바운스), 부딪힌 지점의 radiance를 구한다 — 그 지점의 직접광을 계산하고(그림자 레이 추가), 더 정확히 하려면 거기서 또 광선을 쏜다(2차 바운스, 3차…). 헤더 그림의 코넬 박스가 보여주는 <strong>color bleeding</strong>(빨간 벽이 옆 물체를 붉게 물들이는 것)이 정확히 1차 바운스의 산물이다. 이 방법의 장점은 분명하다 — <strong>어떤 사전 계산도, 어떤 프록시도 없이, 동적인 씬에서 물리적으로 옳은 간접광</strong>이 나온다. 화면 밖 지오메트리도 담고, 라이트맵도 프로브 배치도 필요 없다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그리고 이 방법은 실제로 구현하기도 쉽다. <a href="/raytracing-shader">RT 인프라 글</a>에서 본 부품들 — TLAS에 <code>TraceRay</code> 한 번이면 광선 하나가 날아간다. UE 4.22가 2019년에 곧바로 RTGI를 내놓을 수 있었던 이유다. 문제는 구현이 아니라 <strong>비용의 구조</strong>다. 같은 <code>TraceRay</code>인데, 그림자 레이는 감당이 되고 GI 레이는 감당이 안 된다. 그 차이가 어디서 오는지를 다음 세 장에서 하나씩 본다.
</p>

<span class="section-eyebrow">02 — 벽 ①</span>
</div>

# 첫 번째 벽: 발산 — GI 광선은 GPU의 작동 원리와 싸운다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
GPU는 수십 개의 스레드(warp/wave)가 <strong>같은 명령을 같은 순서로</strong> 실행할 때 빠르다. 그림자 레이는 이 전제와 잘 맞는다 — 인접 픽셀들이 같은 광원을 향해 거의 평행하게 광선을 쏘니, 같은 BVH 노드를 걷고 같은 데이터를 캐시에서 읽는다. 그런데 <strong>디퓨즈 GI 레이는 정의상 반구 전체에서 무작위로 뽑힌다.</strong> 바로 옆 픽셀의 광선끼리도 완전히 다른 방향으로 날아가고, 다른 오브젝트에 부딪히고, 다른 머티리얼을 만난다.
</p>

<div class="callout callout-info">
<div class="callout-title">NVIDIA SER 백서 원문</div>
<p><em>"어떤 표면에서 무작위 방향으로 튕겨 나가는 광선 무리를 그려보라. <strong>출발점이 서로 가까운 광선들조차 서로 다른 머티리얼로 만들어진 서로 다른 오브젝트에 부딪힌다.</strong> 이 서로 다른 머티리얼들을 평가하려면 서로 다른 셰이더를 실행하고, 서로 다른 텍스처·정점 속성·오브젝트별 데이터에 접근해야 한다."</em> — 이것이 <strong>실행 발산</strong>(warp 안에서 다른 코드 경로)과 <strong>데이터 발산</strong>(캐시에 불리한 메모리 접근)을 동시에 일으킨다. Khronos 블로그도 독립적으로 같은 진단을 내린다. 2차 광선은 <em>"무작위 방향으로 흩어지며… 데이터 발산과 제어 흐름 발산을 모두 만들고… GPU의 병렬 자원을 낭비한다."</em></p>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 발산이 얼마나 비싼지는 역설적인 방법으로 측정됐다. NVIDIA Ada 세대가 도입한 <strong>SER(Shader Execution Reordering)</strong>은 히트 셰이더가 실행되기 전에 광선들을 "부딪힌 머티리얼이 비슷한 것끼리" GPU가 재정렬하는 기능이다 — 발산의 <em>원인</em>은 그대로 두고 <em>배치</em>만 바꾸는 것이다. 그런데 그 재정렬만으로 이런 숫자가 나온다.
</p>

<div class="data-table">
<table>
<tr><th>사례 (출처: Khronos/NVIDIA, GDC 2025)</th><th>SER 없이</th><th>SER 켜고</th><th>효과</th></tr>
<tr><td><strong>Black Myth: Wukong</strong> ReSTIR GI 패스 (RTX 4070 Ti, 4K+DLSS)</td><td>15.10ms · warp 일관성 20.5%</td><td>4.08ms · 69.9%</td><td><strong>3.7×</strong></td></tr>
<tr><td>Alan Wake 2 RT 파이프라인</td><td>16.8ms</td><td>10.2ms</td><td>1.6×</td></tr>
<tr><td>Indiana Jones</td><td colspan="2">—</td><td>11~24%</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
읽는 방향이 중요하다. <strong>재정렬만으로 3.7×가 나온다는 것은, 정렬되지 않은 GI 레이가 그만큼을 발산으로 흘리고 있었다는 뜻이다</strong> — warp 일관성 20.5%란 SIMD 레인 다섯 중 넷이 놀고 있었다는 얘기다. 출처 스스로 "머티리얼이 많은 디퓨즈 GI는 SER의 완벽한 사용 사례라 다른 워크로드는 이만큼 안 나온다"고 경고하는데, 그 경고가 오히려 이 글의 논지를 확인해 준다. <strong>GI야말로 발산이 가장 심한 워크로드</strong>라는 뜻이다. 참고로 RT 코어 이전 시대(2012, Aila-Laine-Karras)에는 비간섭 광선조차 "거의 전적으로 FLOPS 한계"로 측정됐다 — 발산과 캐시가 병목이라는 이야기는 트래버설이 하드웨어로 내려간 이후의 것이니, 두 시대의 측정을 섞으면 안 된다.
</p>

<span class="section-eyebrow">03 — 벽 ②</span>
</div>

# 두 번째 벽: 히트 셰이딩 — 부딪힌 다음이 더 비싸다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
광선이 무언가에 부딪혔다고 끝이 아니다. GI 레이의 목적은 "그 지점이 내 쪽으로 반사하는 빛(radiance)"이므로, 히트 지점에서 <strong>머티리얼을 평가하고 그 지점의 직접광을 계산</strong>해야 한다 — 텍스처를 읽고, 머티리얼 그래프를 돌리고, 광원까지 그림자 레이를 또 쏜다. 광선 종류에 따라 비용이 갈리는 핵심 이유가 여기 있다. <a href="/raytracing-shadow">그림자 레이</a>는 "맞았나 안 맞았나"만 알면 되니 히트 셰이딩이 사실상 공짜다(4바이트 payload). SER 백서조차 shadow/AO 레이는 <em>"히트 셰이더가 자명해서 재정렬 비용조차 수지가 안 맞는다"</em>고 쓴다. GI 레이는 정반대다 — <strong>히트 셰이딩이 무겁고 방향 발산도 최악인 조합</strong>이다. 백서가 "재정렬이 빛나는 지점"이라 부르는 자리이자, 광선 중에서 가장 비싼 자리다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 NVIDIA의 공식 모범 사례는 놀랍게도 이렇다 — <strong>GI 레이에는 풀 머티리얼 셰이딩을 하지 말 것을 고려하라.</strong> 원문은 이렇다. <em>"1차 가시성 렌더링에 쓰는 모든 기능을 간접 디퓨즈 조명에 복제하는 것은 필요하지 않은 경우가 많다"</em>, <em>"광선이 비간섭적일수록, 1차 가시성 기능의 정확한 복제는 덜 필요하다."</em> 벤더가 "하드웨어로 광선은 쏴주겠는데, 부딪힌 곳의 셰이딩은 알아서 깎아라"라고 권고하는 셈이다.
</p>

<div class="callout callout-warn">
<div class="callout-title">Epic의 실측 — 4.7배의 차이</div>
<p>UE가 정확히 이 권고대로 설계돼 있다. Lumen HWRT에서 히트 지점을 실제 머티리얼로 평가하는 <strong>Hit Lighting</strong> 모드에 대해 Epic 문서는 <em>"머티리얼을 평가하고 그림자 레이를 트레이스해야 하므로 GPU 비용이 크게 증가한다"</em>고 쓰고, 디퓨즈 GI는 기본적으로 <strong>Surface Cache</strong>(미리 캐시된 라이팅을 히트 지점에서 조회)를 쓴다. SIGGRAPH의 Matrix Awakens PS5 수치가 그 차이의 크기다 — <strong>Hit Lighting 11.54ms vs Surface Cache 2.44ms</strong>. 히트 셰이딩을 캐시 조회로 바꾸는 것만으로 ~4.7×. <a href="/raytracing-shader">RT 인프라 글</a>에서 본 <code>FLumenMinimalPayload</code>(12바이트)가 이 선택이 자료구조에 그대로 드러난 결과다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
발산과 히트 셰이딩이 곱해지는 지점도 있다. 히트 지점마다 <em>다른</em> 머티리얼이므로, 히트 셰이딩 비용은 발산 비용이기도 하다 — UE 4.22 시절 NVIDIA는 리플렉션 히트를 머티리얼별로 정렬하는 것만으로 <em>"50% 이득이 드물지 않고, 곳에 따라 3×"</em>를 측정했다(Turing, 스팟 측정). SER는 이 소프트웨어 정렬을 하드웨어로 내린 것이고, 여기에 <strong>바운스 폭발</strong>이 얹힌다 — 2차 바운스는 1차 히트 지점들에서 또 반구 무작위 광선을 쏘는 것이라, 발산은 더 심해지고 광선 수는 배수로 는다. 그래서 실시간 RTGI는 대부분 1바운스에서 잘랐고, 그 순간 "무한히 튕기는 빛"이라는 GI의 본질이 훼손된다(에너지 손실로 어두워진다). 이 1바운스 제한이 UE의 역사에 그대로 남아 있다(05장).
</p>

<span class="section-eyebrow">04 — 벽 ③</span>
</div>

# 세 번째 벽: 노이즈 — 픽셀당 한 발로는 적분이 수렴하지 않는다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
비용의 벽을 다 넘어도 마지막 벽이 남는다. 반구 적분을 몬테카를로로 추정하는데 실시간 예산은 <strong>픽셀당 최대 ~1개의 GI 광선</strong>이다(Anagnostou, Interplay of Light: <em>"현재 게임들은 최대 1 ray/pixel로 트레이스하며, 결과는 노이즈가 매우 심한 이미지다"</em>). 반구에서 방향 하나를 뽑아 적분 전체를 대표시키는 것이니 분산이 클 수밖에 없고, 특히 디퓨즈 GI의 노이즈는 저주파 얼룩(blotch)이라 눈에 잘 띈다. ReSTIR GI 논문의 첫 문단도 같은 전제에서 출발한다 — <em>"하드웨어 레이 트레이싱의 등장에도, 실시간에서는 픽셀당 소수의 광선만 쏠 수 있다."</em>
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 실시간 RTGI에 디노이저는 선택이 아니라 <strong>전제</strong>다. NVIDIA의 프로덕션 디노이저 라이브러리 NRD는 아예 <strong>~1 path/pixel 신호를 위해 설계</strong>됐다고 스스로를 소개한다. 그런데 디노이징은 공짜가 아니다 — 시간축 누적은 <a href="/temporal-reprojection-rejection">reprojection·rejection</a>의 실패 모드(고스팅, 반응 지연)를 그대로 물려받고, 표준 디노이저 SVGF에 대해서는 <em>"게임에서 눈에 띄는 시간축 지연(temporal lag)을 만든다"</em>는 실무 평가가 있다. 공간 필터는 GI의 디테일(작은 물체의 contact GI)을 지운다. 요컨대 <strong>노이즈를 시간과 공간으로 밀어내는 것이고, 그 대가는 잔상과 뭉개짐이다</strong>. 상세한 디노이저 해부는 <a href="/denoising">디노이징 글</a>에, 노이즈를 근본에서 줄이려는 시도는 <a href="/restir">ReSTIR 글</a>에 있다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">벽 ①</div><div class="step-name">발산</div><div class="step-desc">디퓨즈 반구 샘플링 = 인접 광선끼리 무상관 → warp 일관성 붕괴 (Wukong 20.5%)</div></div>
<div class="flow-arrow">×</div>
<div class="flow-step"><div class="step-num">벽 ②</div><div class="step-name">히트 셰이딩</div><div class="step-desc">히트마다 다른 머티리얼 평가 + 직접광 (11.54 vs 2.44ms) + 바운스 배수</div></div>
<div class="flow-arrow">×</div>
<div class="flow-step"><div class="step-num">벽 ③</div><div class="step-name">노이즈</div><div class="step-desc">~1spp 분산 → 디노이저 전제 → 고스팅·지연·뭉개짐까지 함께 따라옴</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
세 벽은 독립이 아니라 <strong>곱</strong>이다. 발산 때문에 광선 하나가 비싸고, 히트 셰이딩 때문에 광선 하나가 더 비싸져서, 픽셀당 한 발밖에 못 쏘고, 그래서 노이즈가 생기고, 노이즈를 지우다 잔상이 생긴다. "풀 RTGI가 왜 안 쓰이나"의 답은 이 곱셈이다.
</p>

<span class="section-eyebrow">05 — UE의 흥망</span>
</div>

# UE에서의 흥망: 4.22의 야심에서 5.8의 빈 enum까지

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
이 세 벽이 실제 엔진의 역사에 어떻게 새겨졌는지 보자. <strong>UE 4.22(2019년 4월)</strong>는 DXR 얼리 액세스로 레이 트레이스드 리플렉션·섀도우·AO·반투명과 함께 <strong>Ray Traced Global Illumination</strong>을 내놨다. RT 코어가 나온 지 반년 만의 야심찬 전체 세트였다. 그러나 4.27 공식 문서에 남은 문장들이 세 벽의 자백이다 — Final Gather 방식은 <em>"현재 <strong>간접 디퓨즈 GI 1바운스로 제한</strong>되며(1을 넘는 Max Bounces는 <strong>조용히 버려진다</strong>), 이전 프레임 GI 샘플의 리프로젝션은 <strong>고스팅에 취약</strong>하다."</em> 벽 ②(바운스 폭발) 때문에 1바운스에서 자르고, 벽 ③(노이즈) 때문에 시간축 재사용을 했더니 고스팅이 났다는, 교과서적인 궤적이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그리고 UE5에서 조용히 사라졌다. 5.0의 API 문서는 RTGI를 <em>"deprecated technique, use Lumen Global Illumination instead"</em>로 표기했고, 5.8 로컬 소스에서는 흔적이 완전히 지워졌다.
</p>

<div class="code-block"><div class="code-lang">UE 5.8 — 로컬 소스에서 확인한 물증</div><span class="cm">// 1. Renderer 모듈 어디에도 없음:</span>
<span class="cm">//    RayTracingGlobalIllumination.cpp — 파일 자체가 삭제됨 (UE4엔 존재)</span>
<span class="cm">//    "r.RayTracing.GlobalIllumination" — grep 0건</span>

<span class="cm">// 2. 간접광 방법 enum — DeferredShadingRendererTypes.h:5</span>
<span class="kw">enum class</span> <span class="ty">EDiffuseIndirectMethod</span>
{
    Disabled,
    SSGI,
    Lumen,
    Plugin,     <span class="cm">// ← "독립 RTGI"라는 선택지 자체가 메뉴에 없다</span>
};

<span class="cm">// 3. 남은 것: 외부 GI 플러그인(RTXGI류)용 delegate 훅뿐</span>
<span class="cm">//    FGlobalIlluminationPluginDelegates — DeferredShadingRenderer.h:240</span>
<span class="cm">//    ShouldRenderPluginRayTracingGlobalIllumination — IndirectLightRendering.cpp:768</span></div>

<p style="color:var(--text2);line-height:1.85;">
Epic이 "왜"를 명시한 원문은 남아 있지 않다 — 문서화된 사실은 "Lumen으로 대체"까지이고, 이유는 Lumen의 설계에서 역으로 읽어야 한다(다음 장). 흐름 자체는 GI에 국한되지 않았다. 5.4에서는 독립 RT 리플렉션도 포스트 프로세스 볼륨에서 제거됐고(Epic 스태프 확인), 개별 RT 이펙트들은 Lumen이라는 단일 시스템으로 흡수됐다. <strong>"per-pixel로 광선을 쏘는 독립 이펙트" 세대 전체가 "캐시 위에서 광선을 아껴 쓰는 통합 시스템" 세대로 교체</strong>된 것이다.
</p>

<span class="section-eyebrow">06 — 생존 전략</span>
</div>

# 살아남은 자들의 지도: 각자 어느 벽을 우회했나

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
그러면 출하된 기법들은 무엇을 한 것인가. 셋 다 광선을 쓴다 — 다만 <strong>"픽셀마다, 매 프레임, 풀 셰이딩으로"라는 세 조건 중 최소 하나를 버렸다.</strong>
</p>

<div class="data-table">
<table>
<tr><th>전략</th><th>무엇을 버렸나</th><th>벽 ① 발산</th><th>벽 ② 히트 셰이딩</th><th>벽 ③ 노이즈</th><th>대가</th></tr>
<tr><td><strong><a href="/ddgi">DDGI</a></strong> (프로브)</td><td>"픽셀마다"</td><td>프로브당 광선 뭉치로 완화</td><td>광선 수 자체가 적음 (예산이 해상도와 <strong>무관</strong>)</td><td>구조적으로 <strong>노이즈 없음</strong> (프로브 시간축 블렌딩)</td><td>프로브 간격에서 오는 빛 누출과 반응 지연, 낮은 공간 해상도</td></tr>
<tr><td><strong><a href="/lumen">Lumen</a></strong> (캐시)</td><td>"매 프레임" + "풀 셰이딩"</td><td>다운샘플 프로브로 광선 수 압축</td><td><strong>Surface Cache 조회</strong>로 머티리얼 평가 제거 (2.44ms)</td><td>radiance cache + temporal로 흡수</td><td>라이팅 전파 지연 — Epic 문서 그대로 <em>"태양을 꺼도 수 초"</em></td></tr>
<tr><td><strong><a href="/restir">ReSTIR</a></strong> (재사용)</td><td>"내 픽셀의 샘플"</td><td>(발산은 남음 — SER가 필요한 이유)</td><td>(남음 — Cyberpunk가 캐시를 얹은 이유)</td><td>이웃·과거의 좋은 샘플 재사용으로 <strong>분산 자체를 공격</strong></td><td>상관 노이즈, 재검증 비용, 잔상</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
숫자로 보면 선명하다. NVIDIA가 밝힌 DDGI(RTXGI)의 예산은 1080p RTX 2080 Ti 기준 <strong>~1ms/frame</strong>, fixed-time 모드로 1~2ms — 그리고 결정적으로 <em>"성능을 보장하고, 해상도와 무관하게 확장되며, <strong>노이즈가 없다</strong>"</em>고 홍보했다(2019년 기준이고, 당시 SDK는 지금 아카이브 상태다). per-pixel 1spp는 1080p에서만 ~200만 광선, 4K면 ~830만인데, 프로브는 해상도가 올라도 광선 수가 그대로다. Lumen의 압축률은 <a href="/raytracing-shader">인프라 글</a>과 이 글의 로컬 분석에서 이미 봤다 — 기본값으로 계산하면 screen probe는 <strong>16×16 픽셀 타일당 1개, probe당 8×8=64 광선 → 픽셀당 실효 0.25 광선</strong>이다. 거기에 히트 셰이딩은 Surface Cache 조회로, 노이즈는 radiance cache와 시간축으로 넘긴다. 그 대가가 Epic 문서의 저 정직한 문장이다 — <em>"태양을 끄는 것 같은 전역 조명 변화는 <strong>전파에 수 초</strong>가 걸릴 수 있다."</em>
</p>

<div class="callout callout-purple">
<div class="callout-title">엔진의 자백 한 줄 더 — 에너지를 버려 노이즈를 산다</div>
<p>Lumen 소스에는 벽 ③과의 거래가 CVar 주석으로 박제돼 있다. <code>r.Lumen.ScreenProbeGather.MaxRayIntensity</code>(기본 10.0, <code>LumenScreenProbeFiltering.cpp:68</code>) — <em>"최대 광선 강도를 클램프해 파이어플라이를 줄인다. 낮은 값은 노이즈를 줄이지만, <strong>흥미로운 GI 특징도 함께 제거한다</strong>."</em> 밝은 간접광(작은 창으로 들어온 햇빛 반사 같은)을 물리량 그대로 두면 1spp 분산이 폭발하니, 엔진이 <strong>에너지를 잘라(bias) 분산을 산다</strong>. 같은 클램프가 Radiosity·Reflections·ReSTIRGather에도 각각 있다 — Lumen 전역의 패턴이다.</p>
</div>

<span class="section-eyebrow">07 — 업계 현실</span>
</div>

# "풀 레이 트레이싱" 게임들의 실제: 두 개의 사례 연구

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
<strong>사례 ① Metro Exodus Enhanced Edition (2021)</strong> — "RT 필수" 게임의 원조격이다. NVIDIA 공식 문서는 <em>"모든 라이팅이 레이 트레이싱으로 실시간 계산되며, RTX GPU가 필수"</em>라고 쓴다. 2019년 원판이 태양광 1바운스만 레이 트레이싱했던 것을, EE는 모든 광원으로 확장하고 "'무한' 바운스"를 지원한다. 그런데 그 무한 바운스의 구현을 같은 문서가 이렇게 설명한다 — <em>"추가 바운스들은 <strong>즉시가 아니라 1초 이내에 계산되어</strong> 결과가 블렌딩된다"</em>, 방식은 <strong>DDGI 월드 프로브 그리드</strong>. 즉 가장 유명한 '풀 RTGI' 게임의 실체는 <strong>1차 바운스만 정직한 레이 트레이싱 + 나머지는 프로브 캐시 + 1초 미만의 전파 지연</strong>이다. 벽 ②의 바운스 폭발을 정면돌파한 게 아니라, DDGI로 우회한 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>사례 ② Cyberpunk 2077 RT: Overdrive (2023)</strong> — 진짜 패스 트레이싱을 출하한 드문 사례다. 2023년 4월 "Technology Preview"로 출시돼 라이팅 파이프라인 대부분을 패스 트레이싱으로 교체했고, 2.1/Ultimate Edition 시기에 프리뷰 딱지를 뗐다. 주목할 것은 <strong>그 딱지를 떼기 위해 필요했던 스택</strong>이다. GDC 2024에서 CDPR/NVIDIA가 직접 밝힌 3층 — <strong>ReSTIR GI</strong>(시공간 reservoir 재사용, <a href="/restir">ReSTIR 글</a>) + <strong>SHaRC radiance cache</strong>(월드 캐시) + <strong>DLSS Ray Reconstruction</strong>(AI 디노이저). 세 벽에 하나씩 대응하는 구조다 — 노이즈는 재사용으로, 히트 비용은 캐시로, 남은 노이즈는 AI로. "패스 트레이싱을 출하했다"는 말의 실제 뜻은 <strong>"패스 트레이싱 위에 세 벽 각각의 우회 기법을 전부 쌓아서 출하했다"</strong>이다. (벤더가 말한 "near-zero performance cost"는 이 기법들의 증분 비용 얘기지 PT 전체 비용이 아니다 — RTX 4090에서도 DLSS+프레임 생성을 켜야 70~90fps대다.)
</p>

<p style="color:var(--text2);line-height:1.85;">
이 둘 외의 순수 PT급 출하는 Quake II RTX, Portal RTX(구형 게임의 리메이크), Alan Wake 2·Black Myth: Wukong의 PT 모드 정도로, 최고급 GPU 전용 옵션이다. 업계의 기본값은 여전히 프로브·캐시·스크린 공간이고, 풀 레이 트레이싱은 "가능함의 증명"으로 존재한다.
</p>

<span class="section-eyebrow">08 — 하드웨어 전망</span>
</div>

# 하드웨어가 구해줄 것인가: 완화와 제거의 차이

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
"세대가 지나면 해결될 문제 아닌가?"에 대한 현재 시점의 답은 <strong>"완화는 되고 있지만, 벽의 구조는 그대로"</strong>다. SER가 좋은 예다 — 3.7×는 인상적이지만, SER는 발산의 <em>원인</em>(디퓨즈 샘플링의 무작위성)을 없애는 게 아니라 발산한 광선들을 <em>사후에 재정렬</em>하는 것이다. 재정렬 자체에도 비용이 있어 shadow/AO 같은 자명한 워크로드에선 수지가 안 맞고, 이득의 크기는 워크로드·씬·머티리얼 수에 좌우된다(출처 스스로 Wukong은 거의 최상의 경우라고 밝힌다).
</p>

<p style="color:var(--text2);line-height:1.85;">
콘솔 쪽은 구조적 제약이 하나 더 있다. 현세대 콘솔(PS5/Series X)의 RDNA 2는 Chips and Cheese의 마이크로아키텍처 분석대로 <strong>인터섹션 테스트만 하드웨어(TMU)로 하고, BVH 트래버설 루프는 셰이더 코어가 돈다</strong> — 원문 그대로 <em>"셰이더가 BVH를 순회하며 다음 노드를 텍스처 유닛에 넘기는 책임을 진다."</em> 깊은 트리의 포인터 체이싱 구조라 <em>"캐시·메모리 지연에 더 취약"</em>하고, 지연을 가리려면 많은 광선을 동시에 띄워 둬야 하는데 그건 곧 레지스터와 occupancy 압박이다. 비간섭 GI 레이는 정확히 이 급소를 찌르는 워크로드다. 콘솔 세대가 기준선인 한(<a href="/megalights">MegaLights</a>가 ReSTIR를 기각한 그 기준선), 엔진들이 per-pixel RTGI 대신 캐시·프로브를 기본값으로 두는 판단은 당분간 바뀌기 어렵다.
</p>

<div class="callout callout-warn">
<div class="callout-title">이 글이 단정하지 않는 것</div>
<p>검증에서 <strong>기각되거나 미확인으로 남은</strong> 주장들은 본문에서 뺐다 — "현대 GPU의 병목은 트래버설이 아니라 히트 셰이딩이다"(검증 논쟁 중), SER의 세대별 지원 세부, opacity micromap·DGF·neural radiance cache가 격차를 얼마나 줄이는지에 대한 제3자 벤치마크, 콘솔 타이틀들의 실측 프레임 비용. 이 영역들은 1차 소스가 더 쌓인 뒤에 판단할 문제다.</p>
</div>

<span class="section-eyebrow">정리</span>
</div>

# 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
한 문장으로 정리하면 이렇다. <strong>렌더링 방정식을 광선으로 정직하게 푸는 방법은 이론상 옳고 구현도 쉬운 정답이지만, 디퓨즈 바운스의 발산과 히트 지점 셰이딩과 1spp 노이즈라는 세 벽이 곱해지면서 wide-SIMD GPU에서 최악의 워크로드가 됐고, 그래서 업계는 정답 대신 그 결과에 가깝게 보이는 우회로(프로브·캐시·재사용)를 출하했다.</strong> 풀 RTGI는 틀린 답이 아니다 — <strong>비싼 답</strong>이고, 그 비싼 정도가 하드웨어 한 세대로 해결될 수준이 아니었을 뿐이다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">벽 ① 발산</div>
<div class="card-title">GPU와의 구조적 불화</div>
<div class="card-desc">디퓨즈 반구 샘플링 = 인접 광선 무상관. warp 일관성 20.5% → SER 재정렬만으로 3.7× (Wukong ReSTIR GI).</div>
</div>
<div class="card coral">
<div class="card-label">벽 ② 히트 셰이딩</div>
<div class="card-title">부딪힌 다음이 본론</div>
<div class="card-desc">히트마다 다른 머티리얼 + 직접광 재계산. Hit Lighting 11.54ms vs Surface Cache 2.44ms — NVIDIA 공식 권고는 "GI 레이엔 풀 셰이딩을 다시 생각하라".</div>
</div>
<div class="card gold">
<div class="card-label">벽 ③ 노이즈</div>
<div class="card-title">1spp의 세금</div>
<div class="card-desc">NRD는 ~1 path/pixel 전제로 설계된 라이브러리. 디노이저는 전제이고, 그 대가는 고스팅·지연·뭉개짐.</div>
</div>
<div class="card teal">
<div class="card-label">UE의 판결</div>
<div class="card-title">enum에서 지워진 이름</div>
<div class="card-desc">4.22 도입 → 4.27 "1바운스 제한·고스팅" 자백 → 5.0 deprecated → 5.8 {Disabled, SSGI, Lumen, Plugin}. 플러그인 훅만 남았다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
숫자로 다시 새기면 — warp 일관성 20.5→69.9%와 3.7×(SER), 11.54 vs 2.44ms(히트 셰이딩), 픽셀당 실효 0.25 광선과 "수 초"의 전파 지연(Lumen), ~1ms와 "no noise"(DDGI), 그리고 "1초 이내에 계산되는" Metro EE의 무한 바운스. 이 블로그의 GI 글들은 전부 이 세 벽에 대한 각론이었다 — 벽을 프로브로 우회한 <a href="/ddgi">DDGI</a>, 캐시로 우회한 <a href="/lumen">Lumen</a>, 샘플 재사용으로 정면 공격한 <a href="/restir">ReSTIR</a>, 노이즈를 사후에 지우는 <a href="/denoising">디노이징</a>, 시간축 재사용의 규율인 <a href="/temporal-reprojection-rejection">reprojection × rejection</a>, 오프라인에서 정답을 그대로 굽는 <a href="/gpu-lightmass">GPU Lightmass</a>, 그리고 광선이 달리는 도로인 <a href="/raytracing-shader">RT 인프라</a>. 정답은 여전히 저기 있고, 실시간 렌더링의 역사는 그 정답에 얼마나 싸게 가까워질 수 있는가의 역사다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card blue">
<div class="card-label">발산 · SER</div>
<div class="card-title">NVIDIA · Khronos 1차 소스</div>
<div class="card-desc"><a href="https://developer.nvidia.com/blog/best-practices-for-using-nvidia-rtx-ray-tracing-updated/">RTX Ray Tracing Best Practices</a> (2022) · <a href="https://d29g4g2dyqv443.cloudfront.net/sites/default/files/akamai/gameworks/ser-whitepaper.pdf">SER Whitepaper</a> · <a href="https://www.khronos.org/blog/boosting-ray-tracing-performance-with-shader-execution-reordering-introducing-vk-ext-ray-tracing-invocation-reorder">Khronos SER 블로그</a> (Wukong 3.7× 수치, GDC 2025).</div>
</div>
<div class="card teal">
<div class="card-label">UE 문서 · 소스</div>
<div class="card-title">Epic 공식 + UE 5.8 로컬</div>
<div class="card-desc"><a href="https://dev.epicgames.com/documentation/en-us/unreal-engine/real-time-ray-tracing?application_version=4.27">UE 4.27 Real-Time Ray Tracing</a> (Final Gather 자백) · <a href="https://dev.epicgames.com/documentation/unreal-engine/lumen-global-illumination-and-reflections-in-unreal-engine">Lumen 문서</a> (수 초 전파) · <a href="https://dev.epicgames.com/documentation/en-us/unreal-engine/hardware-ray-tracing-in-unreal-engine">HWRT 문서</a> (Hit Lighting 비용) · 로컬 <code>D:\UnrealEngine_5_8</code> — enum·플러그인 훅·Lumen CVar의 file:line.</div>
</div>
<div class="card gold">
<div class="card-label">사례 연구</div>
<div class="card-title">Metro EE · Cyberpunk · DDGI</div>
<div class="card-desc"><a href="https://www.nvidia.com/en-us/geforce/news/metro-exodus-pc-enhanced-edition-ray-tracing-dlss/">Metro Exodus EE</a> (DDGI 프로브 바운스) · <a href="https://www.nvidia.com/en-us/on-demand/session/gdc24-gdc1002/">GDC 2024 RT: Overdrive</a> (ReSTIR GI+SHaRC+RR 스택) · <a href="https://developer.nvidia.com/blog/rtx-global-illumination-part-i/">RTX GI Part 1</a> (~1ms, no noise).</div>
</div>
<div class="card purple">
<div class="card-label">노이즈 · 하드웨어</div>
<div class="card-title">실무 분석</div>
<div class="card-desc"><a href="https://interplayoflight.wordpress.com/2022/03/26/raytraced-global-illumination-denoising/">Interplay of Light — RTGI Denoising</a> (~1 ray/pixel) · <a href="https://github.com/NVIDIA-RTX/NRD">NRD</a> (~1spp 설계) · <a href="https://chipsandcheese.com/p/raytracing-on-amds-rdna-2-3-and-nvidias-turing-and-pascal">Chips and Cheese — RDNA2 RT</a> (셰이더 트래버설) · <a href="https://users.aalto.fi/~ailat1/HPG2009/">Aila &amp; Laine HPG 2009/2012</a>.</div>
</div>
</div>
</div>
