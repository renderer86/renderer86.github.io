---

layout: post
title: "Reflection Capture: 구워둔 큐브맵이 픽셀의 반사가 되기까지 (캡처·GGX 프리필터·합성 패스의 전 경로)"
icon: paper
permalink: reflection-capture
categories: Rendering
tags: [ComputerGraphics, Rendering, ReflectionCapture, IBL, Cubemap, SpecularIBL, ReflectionEnvironment, UnrealEngine]
excerpt: "래스터라이저는 반사를 그릴 수 없다. 화면 밖과 등 뒤의 세상을 모르기 때문이다. 그래서 게임은 반사를 미리 찍어 둔다. 레벨 곳곳에 리플렉션 캡처를 놓고, 그 지점에서 씬을 여섯 방향으로 렌더해 큐브맵으로 저장한 뒤, 러프니스별로 흐려진 밉 체인을 GGX importance sampling으로 미리 구워 둔다. 이 글의 무게중심은 그 다음이다: 구워진 큐브맵 수백 장이 어떻게 하나의 TextureCubeArray와 uniform buffer로 정리되고, 라이트 그리드의 셀마다 추려지고, 합성 패스 하나에서 SSR이 못 채운 알파를 이어받아 작은 캡처부터 차례로 얹힌 뒤 스카이라이트로 끝나는가. UE 5.8 로컬 소스를 기준으로 6면 캡처의 FSceneRenderer ×6 구조, 알파 채널의 스카이 마스크, roughness→mip 매핑 상수 1.2의 의미, 박스·구 패럴랙스 보정의 교차 수식, under 연산자 블렌딩, 반경 오름차순 정렬의 이유, 라이트맵 믹싱, 그리고 Lumen이 켜지면 캡처가 uniform 값 하나로 조용히 꺼지는 지점까지 코드로 추적한다."
back_color: "#ffffff"
img_name: "reflection-capture-core-sketch.webp"
toc: false
show: true
new: true
series: -1
index: 32
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 레벨에 놓는 Sphere/Box Reflection Capture가 내부에서 정확히 무엇을 만들어 저장하는지 궁금한 분
> - "러프니스가 높으면 흐린 반사"가 어떤 사전 계산으로 공짜가 되는지, 밉 체인과 프리필터의 관계를 코드로 보고 싶은 분
> - 만들어진 큐브맵이 **월드의 픽셀에 반사로 입혀지는 합성 경로**(이 글의 핵심)를 셰이더 수준에서 따라가고 싶은 분
> - 캡처 여러 개가 겹칠 때 누가 이기는지, SSR·스카이라이트와는 어떤 순서로 섞이는지 규칙을 알고 싶은 분
> - 박스/구 캡처의 패럴랙스 보정(반사 벡터 재투영)이 어떤 수식인지 원문으로 확인하고 싶은 분
> - Lumen을 켜면 리플렉션 캡처가 어디서 어떻게 무력화되는지, 그래도 살아남는 경로는 어디인지 궁금한 분
>
> **이 글로 알 수 있는 내용**
>
> - 캡처 한 장이 만들어지는 과정: 6면 각각 독립된 씬 렌더러, 캡처 전용 ShowFlags, 모든 표면의 러프니스를 1로 강제하는 이유, 알파 채널의 스카이 마스크
> - GGX importance sampling 프리필터: 샘플 32/64개, filtered importance sampling의 밉 선택, roughness↔mip 매핑 `Mip = MaxMip − 2 + 1.2·log₂(R)`과 그 수치표
> - 저장 구조: MapBuildData(캡처당 약 1MB) → PF_FloatRGBA TextureCubeArray(상한 341장) → 고정 크기 uniform buffer의 float4 패킹
> - 컬링 구조: 반경 오름차순 정렬, 라이트 그리드의 후반부 절반을 캡처가 쓰는 구조, 구 하나로만 하는 컬링
> - 합성 패스: SSR 알파 → 캡처 under 블렌딩 → 스카이라이트 폴백의 3단 체인, 겹침을 처리하는 세 개의 축
> - 패럴랙스 보정 수식 원문: 단위 박스 slab 교차와 구 이차방정식, CaptureOffset이 무엇인지, 경계 페이드 상수(0.7·TD, 반경 60%)
> - 마무리 셰이딩: EnvBRDF가 마지막에 딱 한 번 곱해지는 위치, AO 아홉 군데, 라이트맵 믹싱의 발상
> - 이 방식이 원리적으로 못 하는 것: 벽 너머가 새어 나오는 이유(가시성 판정 부재), 프록시 도형까지만 맞는 패럴랙스, 찍은 순간에 멈춘 데이터, 그리고 광선을 쏘면 그중 무엇이 사라지는지
> - Lumen·레이트레이싱·패스 트레이서 시대에 캡처가 차지하는 자리, 그리고 5.8 소스 트리의 런타임 캡처 확장

<br>

{% include research-post-style.html %}

<div class="research-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# 개요: 반사는 미리 찍어 둔다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
래스터라이저는 반사(Reflection)를 그리지 못한다. 픽셀 하나를 칠할 때 그 픽셀이 아는 것은 자기 표면의 재질과 조명뿐이고, 반사가 비추어야 할 "맞은편 벽"이나 "등 뒤의 창문"은 이미 다른 픽셀로 래스터화되어 지나갔거나 아예 화면 밖에 있다. 그래서 실시간 렌더링의 반사는 전부 우회로다. 화면에 이미 그려진 것을 재활용하거나(<a href="/ssr">SSR</a>), 광선을 실제로 쏘거나(레이트레이싱, Lumen), 아니면 <strong>미리 찍어 둔다</strong>.
</p>

<p style="color:var(--text2);line-height:1.85;">
리플렉션 캡처(reflection capture)가 세 번째 방법이다. 레벨 디자이너가 방마다, 복도마다 캡처 액터를 놓으면, 엔진은 그 지점에서 씬을 여섯 방향으로 렌더해 큐브맵 한 장으로 저장한다. 게임이 돌아갈 때 픽셀은 자기 주변의 캡처 큐브맵에서 반사 방향의 색을 읽어 온다. 광선을 쏘지 않으니 싸고, 화면 밖도 담겨 있으니 SSR처럼 구멍이 나지 않는다. 대신 <strong>찍은 시점, 찍은 위치에 고정된 반사</strong>라는 태생적 한계를 안고 간다. 움직이는 캐릭터는 비치지 않고, 캡처 위치에서 멀어질수록 반사가 어긋난다.
</p>

<div class="scene-fig">
<div class="fig-grid3">
<div class="fig-item">
<svg viewBox="0 0 280 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="방 안의 한 지점에 놓인 캡처 액터가 여섯 방향으로 씬을 렌더하는 그림. 위는 천창, 왼쪽은 창문, 오른쪽은 빨간 벽, 아래는 바닥이다">
<defs>
<marker id="rcap-c" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker>
</defs>
<rect x="20" y="30" width="240" height="180" rx="4" fill="#f2f5fa" stroke="#2b2f3d" stroke-width="2"/>
<rect x="20" y="195" width="240" height="15" fill="#d9a441"/>
<rect x="246" y="30" width="14" height="165" fill="#d6304a"/>
<rect x="20" y="60" width="13" height="62" fill="#8fc1ee"/>
<rect x="96" y="30" width="72" height="12" fill="#bcd8f5"/>
<g stroke="#4338ca" stroke-width="1.7" marker-end="url(#rcap-c)">
<line x1="140" y1="110" x2="140" y2="52"/>
<line x1="140" y1="126" x2="140" y2="186"/>
<line x1="132" y1="118" x2="46" y2="118"/>
<line x1="148" y1="118" x2="236" y2="118"/>
<line x1="133" y1="112" x2="86" y2="76"/>
<line x1="147" y1="124" x2="194" y2="160"/>
</g>
<circle cx="140" cy="118" r="5.5" fill="#4338ca" stroke="#ffffff" stroke-width="1.5"/>
<text x="168" y="104" fill="#2b2f3d" font-size="12" font-weight="600">×6</text>
</svg>
<div class="fig-item-label">① 캡처 액터를 놓은 <strong>그 한 점</strong>에서 90° 화각으로 씬을 여섯 번 렌더한다</div>
</div>
<div class="fig-item">
<svg viewBox="0 0 280 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="여섯 면을 십자로 펼친 큐브맵과, 그 아래 러프니스별로 흐려지는 밉 체인">
<defs>
<marker id="rcap-m" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7d92a8"/></marker>
</defs>
<g stroke="#2b2f3d" stroke-width="1.5">
<rect x="84" y="26" width="44" height="44" fill="#8fc1ee"/>
<rect x="40" y="70" width="44" height="44" fill="#cfe4f8"/>
<rect x="84" y="70" width="44" height="44" fill="#e6ebf2"/>
<rect x="128" y="70" width="44" height="44" fill="#d6304a"/>
<rect x="172" y="70" width="44" height="44" fill="#dfe5ee"/>
<rect x="84" y="114" width="44" height="44" fill="#d9a441"/>
</g>
<g font-size="10" fill="#2b2f3d" text-anchor="middle">
<text x="106" y="52">+Y</text>
<text x="62" y="96">−X</text>
<text x="106" y="96">+Z</text>
<text x="150" y="96" fill="#ffffff">+X</text>
<text x="194" y="96">−Z</text>
<text x="106" y="140">−Y</text>
</g>
<g stroke="#2b2f3d" stroke-width="1.3">
<rect x="34" y="172" width="38" height="38" fill="#9fc4e4"/>
<rect x="82" y="182" width="28" height="28" fill="#aec1cf"/>
<rect x="120" y="190" width="20" height="20" fill="#b9bcb5"/>
<rect x="150" y="196" width="14" height="14" fill="#bfb59c"/>
<rect x="174" y="200" width="10" height="10" fill="#c2b192"/>
</g>
<line x1="196" y1="205" x2="240" y2="205" stroke="#7d92a8" stroke-width="1.5" marker-end="url(#rcap-m)"/>
<text x="218" y="196" fill="var(--text2)" font-size="10.5" text-anchor="middle">러프</text>
</svg>
<div class="fig-item-label">② 여섯 장이 큐브맵 한 장이 되고, 러프니스별로 흐려진 밉이 미리 구워진다(03장)</div>
</div>
<div class="fig-item">
<svg viewBox="0 0 280 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="런타임에 픽셀이 반사 벡터 방향으로 캡처 큐브맵을 한 번 읽는 그림">
<defs>
<radialGradient id="rcap-sp" cx="0.38" cy="0.3" r="0.95"><stop offset="0" stop-color="#f4f7fb"/><stop offset="0.55" stop-color="#c3ccdb"/><stop offset="1" stop-color="#67707f"/></radialGradient>
<clipPath id="rcap-cl"><circle cx="112" cy="150" r="44"/></clipPath>
<clipPath id="rcap-cb"><circle cx="226" cy="64" r="22"/></clipPath>
<marker id="rcap-r" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d6304a"/></marker>
<marker id="rcap-v" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7d92a8"/></marker>
</defs>
<rect x="20" y="28" width="240" height="184" rx="4" fill="none" stroke="#7d92a8" stroke-width="1.4" stroke-dasharray="7 5"/>
<rect x="20" y="197" width="240" height="15" fill="#d9a441"/>
<rect x="248" y="28" width="12" height="169" fill="#d6304a"/>
<circle cx="112" cy="150" r="44" fill="url(#rcap-sp)"/>
<g clip-path="url(#rcap-cl)">
<path d="M 68 128 A 44 44 0 0 1 156 128 Z" fill="#8fc1ee" opacity="0.75"/>
<path d="M 140 118 A 44 44 0 0 1 140 182 Z" fill="#d6304a" opacity="0.55"/>
<path d="M 156 176 A 44 44 0 0 1 68 176 Z" fill="#d9a441" opacity="0.6"/>
</g>
<circle cx="112" cy="150" r="44" fill="none" stroke="#2b2f3d" stroke-width="2"/>
<line x1="40" y1="66" x2="132" y2="115" stroke="#7d92a8" stroke-width="1.6" marker-end="url(#rcap-v)"/>
<line x1="140" y1="118" x2="204" y2="82" stroke="#d6304a" stroke-width="1.8" marker-end="url(#rcap-r)"/>
<circle cx="138" cy="117" r="4.5" fill="#b07d00" stroke="#ffffff" stroke-width="1.2"/>
<circle cx="226" cy="64" r="22" fill="#eef4fb"/>
<g clip-path="url(#rcap-cb)">
<rect x="204" y="42" width="44" height="14" fill="#8fc1ee"/>
<rect x="204" y="74" width="44" height="12" fill="#d9a441"/>
<rect x="238" y="42" width="10" height="44" fill="#d6304a"/>
</g>
<circle cx="226" cy="64" r="22" fill="none" stroke="#2b2f3d" stroke-width="1.6"/>
<text x="84" y="82" fill="var(--text2)" font-size="11" font-style="italic">V</text>
<text x="176" y="92" fill="#d6304a" font-size="11" font-style="italic">R</text>
</svg>
<div class="fig-item-label">③ 런타임에는 픽셀의 반사 벡터 <i>R</i>로 그 큐브맵을 <strong>조회 한 번</strong> 하면 끝이다</div>
</div>
</div>
<div class="scene-cap">캡처 지점에서 사방을 찍어 큐브맵 한 장으로 굽고(①②), 픽셀은 반사 방향으로 그 큐브맵을 읽는다(③). 큐브맵에 담긴 것은 어디까지나 <strong>캡처 지점에서 본 세상</strong>이라, 픽셀이 그 지점에서 멀어질수록 반사가 어긋난다. 이 오차를 줄이는 것이 07장의 패럴랙스 보정이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 글은 UE 5.8 로컬 소스를 기준으로 이 시스템의 전체를 따라간다. 구성은 데이터가 흐르는 순서 그대로다. 큐브맵 반사가 성립하는 원리(01장), 캡처를 굽는 과정(02장)과 러프니스별로 흐리게 만드는 프리필터(03장), 구워진 데이터를 저장하고 GPU에 올리는 방식(04장), 어떤 픽셀이 어떤 캡처를 보는가(05장)를 지나, 이 글의 무게중심인 <strong>합성 패스</strong>(06장)와 패럴랙스 보정(07장), 마무리 셰이딩(08장)에 닿는다. 마지막으로 이 방식이 원리적으로 못 하는 것들(09장), Lumen 시대에 캡처가 차지하는 자리(10장), 5.8 소스 트리의 런타임 캡처 확장(11장)을 본다.
</p>

<div class="flow-row">
<div class="flow-step"><span class="step-num">02장</span><span class="step-name">캡처</span><span class="step-desc">씬을 6면 렌더</span></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><span class="step-num">03장</span><span class="step-name">프리필터</span><span class="step-desc">러프니스별 밉 굽기</span></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><span class="step-num">04장</span><span class="step-name">등록</span><span class="step-desc">큐브맵 어레이 + UB</span></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><span class="step-num">05장</span><span class="step-name">컬링</span><span class="step-desc">정렬 + 그리드 컬링</span></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><span class="step-num">06–08장</span><span class="step-name">합성</span><span class="step-desc">픽셀별 블렌딩</span></div>
</div>

<span class="section-eyebrow">01 — 큐브맵 반사의 원리</span>

</div>

# 큐브맵 하나로 반사가 되는 이유, 그리고 흐린 반사의 문제

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
거울 같은 표면의 반사는 수식으로는 간단하다. 카메라에서 표면으로 오는 시선 벡터를 표면 법선에 대해 접어 반사 벡터 <code>R</code>을 만들고, 그 방향에서 오는 빛을 가져오면 된다. 큐브맵은 "한 점에서 모든 방향으로 보이는 색"을 담는 텍스처이므로, 반사 벡터로 큐브맵을 조회하면 반사가 나온다. 조회 한 번, 끝. 이것이 environment mapping이고 1976년부터 있던 아이디어다.
</p>

<p style="color:var(--text2);line-height:1.85;">
문제는 완전한 거울이 거의 없다는 데 있다. 실제 재질은 대부분 표면이 미세하게 거칠고, 거칠수록 반사는 흐려진다. 물리적으로 말하면 러프니스가 높은 표면의 반사는 반사 벡터 주변의 <strong>수많은 방향에서 오는 빛의 가중 평균</strong>이다. 정직하게 계산하려면 픽셀마다 큐브맵을 수십~수백 방향으로 샘플해서 BRDF<span class="fn-note"><input type="checkbox" id="fn-brdf" class="fn-toggle"><label for="fn-brdf" class="fn-ref">1</label><span class="fn-body"><strong>BRDF(bidirectional reflectance distribution function):</strong> 표면에 특정 방향에서 빛이 들어왔을 때 각 방향으로 얼마나 반사되는지를 정의하는 함수. 실시간 렌더링의 스페큘러는 대부분 GGX라는 BRDF 모델을 쓰며, 러프니스가 이 함수의 "퍼짐 정도"를 조절한다.</span></span> 가중으로 평균해야 한다. 픽셀마다 하기에는 너무 비싸다.
</p>

<p style="color:var(--text2);line-height:1.85;">
게임이 쓰는 해법이 <strong>split-sum 근사</strong>다(Karis, "Real Shading in Unreal Engine 4", SIGGRAPH 2013). 이 적분을 두 조각으로 쪼갠다:
</p>

<div class="formula">전체 적분  ≈  [ 환경광의 가중 평균 ]  ×  [ BRDF의 사전 적분 ]
              └ 프리필터드 큐브맵 밉      └ EnvBRDF 2D LUT (NoV, roughness)</div>

<p style="color:var(--text2);line-height:1.85;">
앞 조각은 큐브맵 쪽에서 해결한다. 러프니스 단계마다 "그 러프니스로 흐려진 큐브맵"을 미리 만들어 <strong>밉 체인</strong>에 저장해 두면, 런타임에는 러프니스에 맞는 밉을 조회 한 번으로 읽으면 된다(03장). 뒤 조각은 재질 쪽에서 해결한다. 시선 각도와 러프니스에만 의존하는 2D 텍스처(PreIntegratedGF)를 한 번 구워 두고, 마지막에 <strong>EnvBRDF</strong><span class="fn-note"><input type="checkbox" id="fn-envbrdf" class="fn-toggle"><label for="fn-envbrdf" class="fn-ref">2</label><span class="fn-body"><strong>EnvBRDF(environment BRDF):</strong> split-sum의 뒤 조각. GGX BRDF의 프레넬·지오메트리 항을 시선 각도(NoV)와 러프니스 두 값만으로 미리 적분해 둔 2D 텍스처다(UE에서는 <code>PreIntegratedGF</code>). 런타임에는 이 텍스처를 한 번 읽어 곱하는 것으로 재질의 반사 응답이 반영된다(08장).</span></span>로 곱한다(08장). 이 두 조각이 준비되면, 흐린 반사도 거울 반사와 똑같이 <strong>텍스처 조회 두 번</strong>으로 끝난다. 픽셀마다 수십~수백 방향을 샘플하던 적분이 조회 두 번으로 줄어드니, 러프니스가 얼마든 반사를 아주 싸게 표현할 수 있다. 실시간 렌더링이 IBL(image-based lighting, 환경을 담은 이미지로 조명하는 방식)을 쓸 수 있게 된 이유가 이것이다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글에서 반복해서 만날 두 개의 알파</div>
<p>여기서 말하는 <strong>알파</strong>는 RGBA의 A, 즉 색(RGB) 옆에 한 칸 더 붙어 다니는 0~1 사이의 숫자다. 원래 뜻은 "이 색이 화면을 얼마나 덮는가"(불투명도)인데, 리플렉션 캡처는 이 한 칸을 서로 다른 두 가지 의미로 쓴다. 이 글에서 알파가 나오면 둘 중 어느 쪽인지 구분해야 한다.</p>
<p><strong>① 합성할 때 픽셀이 들고 있는 알파</strong>는 "이 픽셀의 반사 중 아직 아무도 채우지 못한 비율"이다. 픽셀은 1(하나도 못 채움)에서 출발하고, 반사를 채워 주는 시스템이 자기가 채운 만큼 이 값을 깎아 간다. SSR이 먼저 깎고, 캡처들이 차례로 깎고, 0에 가까워지면 더 볼 필요가 없으니 루프가 멈춘다. 그러고도 남은 값은 마지막에 스카이라이트가 가져간다(06장). 알파를 예산처럼 쓰는 폴백 체인이다.</p>
<p><strong>② 캡처 큐브맵 텍셀 자체의 알파</strong>에는 불투명도 대신 "이 방향에 가까운 지오메트리가 찍혀 있는가"가 들어 있다. 벽이 찍힌 방향은 1, 하늘만 보이는 방향은 0이어서, 캡처가 어느 방향까지 책임지는지를 표시하는 <strong>스카이 마스크</strong>가 된다(02장). 이 두 알파가 곱해지는 한 줄이 이 시스템의 핵심 코드다.</p>
</div>

<span class="section-eyebrow">02 — 캡처 굽기</span>

</div>

# 굽기: 씬을 여섯 번, 통째로 렌더한다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
캡처 한 장을 만드는 코드는 <code>Engine/Source/Runtime/Renderer/Private/ReflectionEnvironmentCapture.cpp</code>에 있다. 해상도는 <code>r.ReflectionCaptureResolution</code>(기본 <strong>128</strong>) 하나로 씬 전체가 공유하고(캡처별 해상도 옵션은 없다), 포맷은 FP16 RGBA다. <code>CaptureSceneIntoScratchCubemap</code>이 큐브맵의 여섯 면을 도는데, 면 하나마다 <strong>완전히 독립된 씬 렌더러를 새로 만든다</strong>. 뷰 패밀리, 뷰, 스크린 퍼센티지 설정, 뷰 익스텐션까지 전부 면마다 새로 생성해서, 90° 화각으로 여섯 방향을 향해 씬을 여섯 번 통째로 렌더한다.
</p>

<div class="code-block"><div class="code-lang">C++ — ReflectionEnvironmentCapture.cpp (면당 뷰 설정, 발췌)</div><span class="cm">// Each face always uses a 90 degree field of view</span>
ViewInitOptions.ProjectionMatrix = <span class="fn">GetCubeProjectionMatrix</span>(<span class="num">45.0f</span>, CubemapSize * SupersampleCaptureFactor, NearPlane);
ViewInitOptions.ViewRotationMatrix = <span class="fn">CalcCubeFaceViewRotationMatrix</span>((<span class="ty">ECubeFace</span>)CubeFace);
ViewInitOptions.bIsReflectionCapture = <span class="kw">true</span>;

<span class="cm">// Force all surfaces diffuse</span>
View-&gt;RoughnessOverrideParameter = <span class="ty">FVector2f</span>(<span class="num">1.0f</span>, <span class="num">0.0f</span>);</div>

<p style="color:var(--text2);line-height:1.85;">
마지막 줄이 중요하다. 캡처를 렌더하는 동안 <strong>모든 표면의 러프니스를 1로 강제</strong>한다. 캡처 안에 다른 표면의 스페큘러 반사가 선명하게 찍혀 있으면, 그 캡처를 반사로 쓰는 순간 반사 속에 또 반사가 들어가 스페큘러가 이중으로 계산되기 때문이다. 캡처는 디퓨즈한 세상만 찍는다. 같은 이유로 ShowFlags에서 포스트 프로세싱, 모션 블러, 파티클, 라이트 섀프트가 전부 꺼진다. 캡처된 반사가 실제 화면보다 밋밋해 보이는 주원인이 이 목록이다. near plane은 CVar도 없는 전역 상수 <code>GReflectionCaptureNearPlane = 5</code>(5cm), far plane은 무한이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
렌더된 씬 컬러를 큐브 면으로 복사하는 픽셀 셰이더(<code>CopySceneColorToCubeFaceColorPS</code>, ReflectionEnvironmentShaders.usf)가 이 시스템의 설계 하나를 결정한다. <strong>알파 채널에 스카이 마스크를 쓴다.</strong> 씬에 stationary 스카이라이트가 있으면, 캡처 위치에서 <code>SkyDistanceThreshold</code>보다 먼 픽셀(= 사실상 하늘)의 알파를 0으로 페이드한다:
</p>

<div class="code-block"><div class="code-lang">HLSL — CopySceneColorToCubeFaceColorPS (스카이 마스크)</div><span class="kw">float</span> RadialDistance = <span class="fn">length</span>(TranslatedWorldPosition - View.TranslatedWorldCameraOrigin);
<span class="kw">float</span> MaxDistance = SkyLightCaptureParameters.y;   <span class="cm">// SkyDistanceThreshold</span>

<span class="cm">// Setup alpha to fade out smoothly past the max distance</span>
<span class="cm">// This allows a local reflection capture to only provide reflections where it has valid data, falls back to sky cubemap</span>
Alpha = <span class="num">1</span> - <span class="fn">smoothstep</span>(<span class="num">.8f</span> * MaxDistance, MaxDistance, RadialDistance);

<span class="cm">// We need pre-multiplied alpha for correct filtering</span>
<span class="cm">// However, we need to compute average brightness before masking out sky areas, so premultiplying happens later</span>
OutColor = <span class="kw">float4</span>(SceneColor, Alpha);</div>

<p style="color:var(--text2);line-height:1.85;">
이 알파 덕분에 캡처는 "내가 유효한 데이터를 가진 방향"만 책임지고, 하늘이 보이는 방향은 런타임의 스카이라이트 큐브맵에 넘길 수 있다. 하늘 큐브맵을 교체해도(시간대 변경 등) 이미 구운 캡처를 다시 굽지 않아도 되는 것이 이 한 줄의 효과다. 06장에서 이 알파가 합성의 "under 연산자"와 만난다.
</p>

<div class="callout callout-info">
<div class="callout-title">스카이라이트도 같은 코드로 굽는다</div>
<p>알파를 넘겨받는 스카이라이트가 무엇인지 짚고 가자. Sky Light 액터가 하는 일도 리플렉션 캡처와 거의 같다. 소스 타입이 Captured Scene이면 <code>FScene::UpdateSkyCaptureContents</code>(ReflectionEnvironmentCapture.cpp, 캡처와 같은 파일)가 캡처와 <strong>완전히 같은 함수</strong>인 <code>CaptureSceneIntoScratchCubemap</code>을 호출해서, 컴포넌트 위치에서 씬을 여섯 방향으로 렌더한다. HDRI를 직접 지정하는 Specified Cubemap 모드면 그 이미지를 스크래치 큐브맵으로 복사할 뿐, 이후 경로는 똑같다. 프리필터도 같은 <code>FilterReflectionEnvironment</code>를 그대로 쓴다(03장).</p>
<p>다른 점은 하나다. 스카이라이트는 이 프리필터 함수에 SH 계수 출력 인자(<code>OutIrradianceEnvironmentMap</code>)를 함께 넘겨 <code>ComputeDiffuseIrradiance</code>까지 돌린다. 그래서 스카이라이트는 <strong>디퓨즈용 <a href="/spherical-harmonics">SH</a> 계수 + 스페큘러용 프리필터 큐브맵</strong> 두 벌을 만들고, 리플렉션 캡처는 같은 자리에 <code>nullptr</code>을 넘겨 <strong>스페큘러 큐브맵만</strong> 만든다.</p>
<p>정리하면 씬을 큐브맵으로 굽고 러프니스별로 흐리게 만들어 조명으로 쓴다는 얼개가 둘이 같고, 담당 범위만 다르다. 캡처는 방 하나를 맡는 국소 버전, 스카이라이트는 씬 전체를 덮는 전역 버전이다. 이 알파 한 줄이 "여기서부터는 전역 쪽이 맡는다"는 경계선을 그어 주기 때문에, 06장의 합성에서 캡처가 못 채운 방향을 스카이라이트가 그대로 이어받을 수 있다.</p>
</div>

<div class="callout callout-warn">
<div class="callout-title">굽기가 느린 이유는 소스에 적혀 있다</div>
<p>면 하나를 렌더할 때마다 <code>SubmitAndBlockUntilGPUIdle()</code>로 GPU 전체를 비우고 기다린다. 캡처 N개면 6N번의 풀 GPU 싱크다. 빌드 시 GPU→CPU 리드백도 밉×면 = 48회의 개별 블로킹 호출로 이루어지며, 소스에 <code>//@todo - do this without blocking the GPU so many times</code>가 그대로 남아 있다. 여기에 Build Reflection Captures는 캡처를 <strong>두 번</strong> 수행한다: 모바일용(하늘을 구워 넣은 버전)과 범용(하늘을 마스킹한 버전)은 픽셀 내용 자체가 달라서 포맷 변환으로 해결이 안 되기 때문이다. 또한 스카이라이트를 먼저 굽고 캡처를 굽는 순서가 강제된다. 스카이의 디퓨즈가 캡처의 간접광에 찍혀야 하기 때문이다.</p>
</div>

<span class="section-eyebrow">03 — 프리필터</span>

</div>

# 프리필터: 러프니스를 밉 체인에 굽는다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
씬이 담긴 스크래치 큐브맵은 아직 찍은 그대로, 흐림 처리를 전혀 거치지 않은 선명한 이미지다. 완전한 거울면에나 그대로 쓸 수 있고, 조금이라도 거친 표면에는 맞지 않는다. 01장의 split-sum 앞 조각, 즉 러프니스별로 흐려진 버전들을 만드는 것이 <code>FilterReflectionEnvironment</code>다. 순서는 프리멀티플라이 → 밉 체인 생성 → 필터링이다. 구운 큐브맵을 최종 렌더링에 쓰려면 이 세 단계를 반드시 거쳐야 하는데, 각 단계가 왜 필요한지 하나씩 확인해 보자.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>프리멀티플라이</strong>는 셰이더 없이 블렌드 스테이트만으로 한다. 검은색을 그리면서 블렌드 식을 <code>RGB = Src·0 + Dst·DstAlpha</code>로 걸면 결과가 <code>RGB *= Alpha</code>가 된다. 필터링할 때 스카이 마스크가 색에 미리 곱해져 있어야 경계가 올바르게 흐려지기 때문이다. <strong>밉 체인</strong>은 단순 2×2 박스 축소가 아니라 9탭 커널(중심 1 + 주변 8탭 각 0.375)인데, 탭의 오프셋을 2D 텍셀 좌표가 아니라 <strong>접선 공간의 방향 벡터</strong>로 주고 하드웨어 큐브맵 샘플러에 맡긴다. 큐브 면 경계에서 이웃 면으로 자연스럽게 넘어가므로 면 사이 이음매가 생기지 않는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
핵심은 <strong>필터(<code>FilterPS</code>)</strong>다. 가우시안이나 콘 필터가 아니라, GGX BRDF를 따라 방향을 뽑는 <strong>importance sampling<span class="fn-note"><input type="checkbox" id="fn-is" class="fn-toggle"><label for="fn-is" class="fn-ref">3</label><span class="fn-body"><strong>importance sampling:</strong> 적분을 몬테카를로로 추정할 때 아무 방향이나 고르지 않고, 피적분 함수가 큰(중요한) 방향을 더 자주 뽑아 같은 샘플 수로 노이즈를 줄이는 기법. 여기서는 GGX 로브가 큰 방향을 집중적으로 샘플한다.</span></span></strong>이다. 밉 인덱스에서 러프니스를 역산하고, 그 러프니스의 GGX 분포로 샘플 방향을 만들어 평균한다:
</p>

<div class="code-block"><div class="code-lang">HLSL — ReflectionEnvironmentShaders.usf FilterPS (핵심 루프)</div><span class="kw">float</span> Roughness = <span class="fn">ComputeReflectionCaptureRoughnessFromMip</span>(MipIndex, NumMips - <span class="num">1</span>);
<span class="kw">const uint</span> NumSamples = Roughness &lt; <span class="num">0.1</span> ? <span class="num">32</span> : <span class="num">64</span>;   <span class="cm">// 모바일: 16/32/64</span>

<span class="kw">for</span>(<span class="kw">uint</span> i = <span class="num">0</span>; i &lt; NumSamples; i++)
{
    <span class="kw">float2</span> E = <span class="fn">Hammersley</span>(i, NumSamples, <span class="num">0</span>);
    <span class="kw">float3</span> H = <span class="fn">ImportanceSampleGGX</span>(E, <span class="fn">Pow4</span>(Roughness)).xyz;   <span class="cm">// GGX 분포에서 하프벡터 샘플</span>
    <span class="kw">float3</span> L = <span class="num">2</span> * H.z * H - <span class="kw">float3</span>(<span class="num">0</span>,<span class="num">0</span>,<span class="num">1</span>);
    <span class="kw">if</span>(NoL &gt; <span class="num">0</span>)
    {
        <span class="cm">// filtered importance sampling: 샘플의 입체각에 맞는 밉에서 읽어 노이즈 억제</span>
        <span class="kw">float</span> PDF = <span class="fn">D_GGX</span>(<span class="fn">Pow4</span>(Roughness), NoH) * <span class="num">0.25</span>;
        <span class="kw">float</span> SolidAngleSample = <span class="num">1.0</span> / (NumSamples * PDF);
        <span class="kw">float</span> Mip = <span class="num">0.5</span> * <span class="fn">log2</span>(SolidAngleSample / SolidAngleTexel);

        FilteredColor += SourceCubemapTexture.<span class="fn">SampleLevel</span>(Sampler, <span class="fn">mul</span>(L, TangentToWorld), Mip) * NoL;
        Weight += NoL;
    }
}
OutColor = FilteredColor / Weight;</div>

<p style="color:var(--text2);line-height:1.85;">
샘플이 32~64개뿐인데 결과가 깨끗한 것은 <strong>filtered importance sampling</strong> 덕분이다. 샘플 하나가 담당하는 입체각이 크면(러프하거나 PDF가 낮으면) 그만큼 흐린 밉에서 읽어서, 샘플 수 부족을 밉의 사전 평균으로 메꾼다. 러프니스가 0.01 미만인 밉은 필터를 생략하고 원본을 복사하며, 0.99를 넘으면 GGX가 상수에 가까워지므로 코사인 분포로 바꾼다. 참고로 이 셰이더 본문은 스카이라이트 프리필터(실시간 캡처의 <code>FilterCS</code> 포함)와 <strong>완전히 동일한 코드</strong>다. 캡처와 스카이라이트는 프리필터 파이프라인을 통째로 공유한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
러프니스와 밉의 대응은 상수 두 개로 정의된다(<code>ReflectionEnvironmentShared.ush</code>). 이 함수는 굽는 쪽과 읽는 쪽(08장)이 똑같이 쓴다:
</p>

<div class="formula">Mip = CubemapMaxMip − 2 + 1.2 · log₂(Roughness)      (REFLECTION_CAPTURE_ROUGHEST_MIP = 1, MIP_SCALE = 1.2)

해상도 128 (MaxMip = 7, 밉 8장) 기준:
mip 0 (128²) → R 0.056     mip 3 (16²) → R 0.315     mip 6 (2²) → R 1.78
mip 1 (64²)  → R 0.099     mip 4 (8²)  → R 0.561     mip 7 (1²) → R 3.17
mip 2 (32²)  → R 0.177     mip 5 (4²)  → R 1.0</div>

<p style="color:var(--text2);line-height:1.85;">
수치표에서 두 가지가 읽힌다. 첫째, 기본 해상도 128에서는 <strong>러프니스 0.056보다 매끈한 반사를 캡처가 표현할 수 없다</strong>. mip 0이 이미 그만큼 흐리다. 거울 같은 표면이 필요하면 해상도를 올리거나 SSR·Lumen·플래너 리플렉션이 필요하다. 둘째, 매핑을 1×1 밉에서 역산하도록 만들어 두어서 해상도를 올려도 "특정 러프니스 = 특정 밉의 흐림"이라는 대응이 유지되고, 샤프한 밉이 앞에 추가될 뿐이다. 마지막 세 밉은 러프니스 1 이상, 즉 사실상 코사인 컨볼브된 디퓨즈다.
</p>

<p style="color:var(--text2);line-height:1.85;">
필터와 별도로 <code>ComputeAverageBrightness</code>가 1×1 밉의 6면을 평균해 숫자 하나(<code>(R+G+B)/3</code>, 가중 휘도도 아닌 산술 평균)를 뽑아 저장한다. 이 값은 08장의 라이트맵 믹싱에서 분모로 쓰인다. 여기서 부작용이 하나 생긴다. 이 계산은 "하늘을 마스킹하기 전" 밝기가 필요해서 프리멀티플라이 앞에서 자기 밉 체인을 한 번 만들고, 필터가 프리멀티플라이 후에 밉 체인을 또 만든다. <strong>밉 체인이 두 번 생성된다</strong>. 위 스카이 마스크 셰이더의 마지막 주석("premultiplying happens later")이 바로 이 순서 때문에 붙어 있다.
</p>

<span class="section-eyebrow">04 — 저장과 등록</span>

</div>

# 데이터를 저장하는 곳: MapBuildData에서 큐브맵 어레이까지

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
구워진 결과는 컴포넌트가 아니라 레벨의 <code>MapBuildData</code>에 저장된다. 키는 컴포넌트의 <code>MapBuildDataId</code>(GUID)이고, 내용은 <code>CubemapSize</code>, <code>AverageBrightness</code>, 그리고 FP16 픽셀의 전체 밉 체인(<code>FullHDRCapturedData</code>)이다. 해상도 128 기준 캡처당 약 <strong>1.0MB</strong>. 모바일용으로는 알파(스카이 마스크)를 버리고 R11G11B10으로 줄인 <code>EncodedHDRCapturedData</code>가 함께 저장된다. 쿠킹 시 타깃 플랫폼이 필요한 쪽만 남긴다. 쿠킹된 게임에서는 이 데이터를 GPU에 한 번 올린 뒤 CPU 사본을 버리기 때문에(<code>OnDataUploadedToGPUFinal</code>), <strong>게임 중 베이크 캡처의 재캡처는 불가능하고</strong>, 라이팅 시나리오를 전환하려면 레벨을 다시 로드해야 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
런타임에 캡처들이 모이는 곳은 씬당 하나뿐인 <strong><code>TextureCubeArray</code></strong>다(<code>FReflectionEnvironmentCubemapArray</code>, 이름 "ReflectionEnvs"). 포맷은 캡처와 같은 PF_FloatRGBA다. 알파의 스카이 마스크가 여기까지 그대로 유지된다. 슬라이스 규약은 <code>큐브인덱스 × 6 + 면</code>이고, 컴포넌트가 슬롯을 받는 과정은 비트 배열에서 빈 비트를 찾는 단순한 할당이다(<code>FindOrAllocateCubemapIndex</code>). 같은 <code>MapBuildDataId</code>를 공유하는 컴포넌트들(레벨 인스턴스로 복제된 캡처)은 refcount로 <strong>슬롯 하나를 공유</strong>한다.
</p>

<div class="data-table">
<table>
<tr><th>제약</th><th>값</th><th>출처</th></tr>
<tr><td>어레이 최대 캡처 수</td><td><strong>341</strong> (모바일 100)</td><td>D3D 텍스처 어레이 한계 2048 레이어 ÷ 6면 = 341.33 (SceneRendering.h 주석)</td></tr>
<tr><td>메모리 상한</td><td>전용 VRAM의 3/4, 리소스당 4GB−1</td><td>초과 시 에디터는 해상도를 절반씩 낮추며 Error 로그, 쿠킹 빌드는 "OOM likely" 로그 후 강행</td></tr>
<tr><td>리사이즈 슬랙</td><td>1.5ⁿ 올림</td><td>캡처 추가/제거 때마다 재할당하지 않도록 1.5의 거듭제곱 크기로 잡음</td></tr>
<tr><td>개수만 변할 때</td><td>GPU→GPU 복사로 내용 보존</td><td>해상도가 변하면 전체 폐기 + 재업로드 (쿠킹 빌드에서는 CPU 원본이 없어 <code>check()</code> 크래시)</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
341개를 넘기면 어떻게 될까? <strong>경고 없이 잘린다</strong>. 게임 스레드의 등록 리스트가 상한에서 더 받지 않고, 셰이더로 가는 리스트를 채우는 루프도 상한에서 멈춘다. 로그가 나오는 것은 메모리 상한 경로뿐이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
셰이더가 캡처의 메타데이터(위치·반경·모양·박스 트랜스폼)를 읽는 통로는 StructuredBuffer가 아니라 <strong>고정 크기 배열 uniform buffer</strong>(<code>FReflectionCaptureShaderData</code>)다. 341이라는 상한이 완화되지 않는 이유 중 하나다. float4 패킹은 다음과 같고, 06~07장의 셰이더가 전부 이 표를 읽는다:
</p>

<div class="data-table">
<table>
<tr><th>배열</th><th>.x .y .z</th><th>.w</th></tr>
<tr><td><code>PositionHighAndRadius[i]</code></td><td>월드 위치 (LWC high)</td><td>InfluenceRadius</td></tr>
<tr><td><code>PositionLow[i]</code></td><td>월드 위치 (LWC low)</td><td>(5.8 트리: 리프레시 블렌드 패킹)</td></tr>
<tr><td><code>CaptureProperties[i]</code></td><td>Brightness · 큐브맵 어레이 인덱스 · 모양(0=구, 1=박스, 2=평면)</td><td>페이드 알파</td></tr>
<tr><td><code>CaptureOffsetAndAverageBrightness[i]</code></td><td>CaptureOffset</td><td>AverageBrightness (03장의 그 숫자)</td></tr>
<tr><td><code>BoxTransform[i]</code></td><td colspan="2">월드→박스 로컬 역행렬 (4×4)</td></tr>
<tr><td><code>BoxScales[i]</code></td><td>박스 half-extent</td><td>BoxTransitionDistance</td></tr>
</table>
</div>

<span class="section-eyebrow">05 — 픽셀로 가는 길</span>

</div>

# 어떤 픽셀에 어떤 캡처가: 정렬과 라이트 그리드

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
씬에 캡처가 수백 개인데 픽셀이 전부 검사할 수는 없다. 추리는 과정은 두 단계다: 씬 단위의 <strong>정렬</strong>과 뷰 단위의 <strong>그리드 컬링</strong>.
</p>

<p style="color:var(--text2);line-height:1.85;">
정렬(<code>UpdateReflectionSceneData</code>, RendererScene.cpp)은 프레임마다 씬에서 한 번 일어난다. 정렬 기준은 카메라 거리가 아니라 <strong>InfluenceRadius 오름차순</strong>이다(동률이면 경로명 해시로 결정론 보장). 이유는 06장의 블렌딩 방식에 있다. 합성 루프는 리스트 앞쪽 캡처에 우선권을 주는 구조라서, 작은 캡처를 앞에 두면 "방 전체를 덮는 큰 캡처 위에, 구석의 정밀한 작은 캡처가 얹히는" 자연스러운 우선순위가 공짜로 나온다. 빌드 데이터가 없거나 아직 큐브맵이 렌더되지 않은 캡처는 이 리스트에서 제외된다.
</p>

<p style="color:var(--text2);line-height:1.85;">
컬링은 별도 시스템 없이 <strong>라이트 그리드를 그대로 쓴다</strong>. 클러스터드 라이팅이 쓰는 그리드 버퍼가 사실 두 배 크기로 잡혀 있고(<code>NumCulledGridPrimitiveTypes = 2</code>), 앞 절반은 라이트, <strong>뒤 절반은 리플렉션 캡처</strong>의 셀별 인덱스 리스트다. 컴퓨트 셰이더(<code>LightGridInjection.usf</code>)가 셀마다 캡처의 영향 구와 셀 AABB의 거리를 비교해 리스트를 채운다. 여기서 두 가지를 짚어 두자. 먼저 <strong>박스 캡처도 컬링은 구로만 한다</strong>(라이트가 받는 스팟 콘·rect 평면 같은 정제가 캡처에는 없다). 그리고 링크드 리스트 컬링 모드에서 캡처는 라이트와 달리 순서 재배열 없이 리스트를 역순 복원한다. <strong>정렬 순서가 곧 블렌딩 순서라서 순서가 보존되어야 하기 때문</strong>이다. 멀리 있는 캡처가 잘리지 않도록 그리드의 far plane도 캡처 거리(<code>FurthestReflectionCaptureDistance</code>)만큼 늘어난다.
</p>

<div class="callout callout-purple">
<div class="callout-title">디퍼드 풀스크린 패스도 이 그리드를 쓴다</div>
<p>06장의 합성 패스는 화면 전체를 덮는 픽셀 셰이더인데, 내부에서 픽셀의 화면 위치와 깊이로 그리드 셀 인덱스를 계산해(<code>ComputeLightGridCellIndex</code>) 그 셀의 캡처 리스트만 순회한다. 즉 클러스터드 컬링은 포워드 전용이 아니라 디퍼드 반사(Deferred Reflections)의 컬링이기도 하다. 참고로 옛 문서에 나오는 타일드 컴퓨트 방식은 5.8에 없다. <code>r.DoTiledReflections</code>는 정의만 남고 아무도 읽지 않는 데드 CVar고, PS 클래스에 "tiled deferred culling"이라는 낡은 주석만 남아 있다.</p>
</div>

<span class="section-eyebrow">06 — 합성 패스</span>

</div>

# 합성 패스: SSR 다음, 스카이라이트 이전

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
여기부터가 이 글의 무게중심이다. 구워진 큐브맵이 화면 픽셀의 반사가 되는 곳은 <code>RenderDeferredReflectionsAndSkyLighting</code>(IndirectLightRendering.cpp, 이름과 달리 ReflectionEnvironment.cpp에는 이 함수가 없다)이고, 실행 시점은 <strong>직접광(RenderLights)까지 끝난 뒤</strong>다. 씬 컬러에 이미 직접광과 디퓨즈 GI가 쌓인 상태에서, 이 패스가 풀스크린 삼각형 하나를 additive 블렌드(<code>BF_One, BF_One</code>)로 그려 스페큘러 IBL과 동적 스카이 디퓨즈를 얹는다. depth bounds 테스트로 하늘 픽셀은 웨이브 자체를 띄우지 않는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
픽셀 셰이더(<code>ReflectionEnvironmentPixelShader.usf</code>)의 흐름을 요약하면 이렇다. 각 단계는 08장에서 하나씩 다시 본다.
</p>

<div class="code-block"><div class="code-lang">HLSL — ReflectionEnvironment() 흐름 요약 (의사코드)</div><span class="cm">// ① 반사 벡터: 거울 반사 R을 러프니스에 따라 살짝 노멀 쪽으로 (off-specular peak 보정)</span>
R = <span class="fn">lerp</span>(N, <span class="fn">reflect</span>(-V, N), (<span class="num">1</span>-a) * (<span class="fn">sqrt</span>(<span class="num">1</span>-a) + a));            <span class="cm">// a = Roughness²</span>

<span class="cm">// ② SSR(또는 Lumen standalone) 텍스처를 읽어 알파 예산 초기화</span>
Color.rgb = SSR.rgb;
Color.a   = <span class="num">1</span> - SSR.a;                        <span class="cm">// SSR이 못 채운 만큼만 남는다</span>

<span class="cm">// ③ AO로 예산 감소: SSAO × GBufferAO → specular occlusion</span>
Color.a  *= <span class="fn">GetSpecularOcclusion</span>(NoV, Roughness², AO);

<span class="cm">// ④ 이 픽셀의 그리드 셀에서 캡처 리스트를 받아 합성 (아래 under 연산)</span>
Color.rgb += View.PreExposure * <span class="fn">CompositeReflectionCapturesAndSkylightTWS</span>(Color.a, ...);

<span class="cm">// ⑤ EnvBRDF: split-sum의 뒷조각을 SSR+캡처+스카이 합계에 마지막 한 번</span>
Color.rgb *= <span class="fn">EnvBRDF</span>(SpecularColor, Roughness, NoV);</div>

<p style="color:var(--text2);line-height:1.85;">
④의 합성 함수(<code>ReflectionEnvironmentComposite.ush</code>)가 이 시스템의 핵심이다. 05장에서 반경 오름차순으로 정렬된 캡처 리스트를 앞에서부터 돌며, 각 캡처를 <strong>under 연산자</strong>로 쌓는다:
</p>

<div class="code-block"><div class="code-lang">HLSL — CompositeReflectionCapturesAndSkylightTWS (캡처 루프 핵심)</div><span class="kw">for</span> (<span class="kw">uint</span> TileCaptureIndex = <span class="num">0</span>; TileCaptureIndex &lt; NumCapturesAffectingTile; TileCaptureIndex++)
{
    <span class="kw">if</span> (ImageBasedReflections.a &lt; <span class="num">0.001</span>) <span class="kw">break</span>;          <span class="cm">// 예산 소진 → 조기 종료</span>

    <span class="cm">// 그리드 셀 리스트에서 캡처 인덱스 → 위치·반경 → 영향 구 밖이면 스킵</span>
    <span class="cm">// 모양별 패럴랙스 보정 + 경계 페이드 → ProjectedCaptureVector, DistanceAlpha (07장)</span>

    <span class="kw">float4</span> Sample = ReflectionStruct.ReflectionCubemap.<span class="fn">SampleLevel</span>(
        Sampler, <span class="kw">float4</span>(ProjectedCaptureVector, CaptureArrayIndex), Mip);   <span class="cm">// TextureCubeArray</span>

    Sample.rgb *= DistanceAlpha * Brightness * IndirectSpecularOcclusion * ImageBasedReflections.a;
    Sample.a   *= DistanceAlpha;                          <span class="cm">// Sample.a = 스카이 마스크(02장)</span>

    <span class="cm">// Under operator (back to front)</span>
    ImageBasedReflections.rgb += Sample.rgb;
    ImageBasedReflections.a   *= <span class="num">1</span> - Sample.a;            <span class="cm">// 이 캡처가 채운 만큼 예산 차감</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
under 연산자는 "먼저 온 것이 위"인 블렌딩이다. 새 캡처의 색에 남은 알파(<code>ImageBasedReflections.a</code>)를 곱해 더하므로, 앞선 캡처가 이미 채운 부분에는 뒤의 캡처가 끼어들 수 없다. 그래서 캡처가 겹칠 때의 우선순위는 세 개의 독립된 축으로 결정된다:
</p>

<div class="data-table">
<table>
<tr><th>축</th><th>메커니즘</th><th>효과</th></tr>
<tr><td>① 순서</td><td>반경 오름차순 정렬 + under 연산</td><td>작은(구체적인) 캡처가 큰 캡처 위에 보인다</td></tr>
<tr><td>② 공간</td><td>DistanceAlpha: 영향 볼륨 경계에서 0으로 페이드 (07장)</td><td>캡처 경계에 딱딱한 이음선이 생기지 않는다</td></tr>
<tr><td>③ 방향</td><td>Sample.a: 큐브맵 알파의 스카이 마스크 (02장)</td><td>하늘이 보이는 방향에서는 알파를 소비하지 않고 다음 캡처/스카이로 넘긴다</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
루프가 끝나고도 알파가 남아 있으면, 즉 어떤 캡처도 책임지지 않은 방향이면 <strong>스카이라이트가 마지막 폴백</strong>으로 남은 알파를 가져간다. 스카이 큐브맵도 같은 밉 매핑 함수로 러프니스에 맞는 밉을 읽고, 두 스카이 큐브맵 사이의 블렌드(<code>BlendFraction</code>)도 여기서 지원된다. 결국 한 픽셀의 스페큘러는 <strong>SSR → 작은 캡처 → 큰 캡처 → 스카이라이트</strong> 순으로 알파 예산을 나눠 갖는 하나의 체인이다. 캡처가 하나도 없을 때도 이 셰이더는 그대로 도는데, 이때 바인딩되는 폴백 텍스처가 "알파가 0인 검은 큐브맵 어레이"라서(소스 주석 그대로 "alpha of 0 ... so the sky cubemap can still be applied"), 알파가 소비되지 않고 스카이라이트만 온전히 적용된다.
</p>

<div class="callout callout-warn">
<div class="callout-title">"largest captures first"라는 주석은 코드와 반대다</div>
<p>합성 루프 위에는 "applying largest captures first so that the smallest ones display on top"이라는 주석이 있다. 그런데 실제 정렬 키(<code>FReflectionCaptureSortKey::operator&lt;</code>)는 반경 <strong>오름차순</strong>, 즉 작은 것이 먼저다. under 연산에서는 먼저 온 쪽이 위이므로 최종 결과("작은 캡처가 위")는 주석의 의도와 일치하지만, "큰 것 먼저"라는 서술 자체는 현재 코드와 모순된 낡은 주석이다. 어느 시점에 over에서 under로 (또는 정렬 방향이) 바뀌면서 주석만 남은 것으로 보인다.</p>
</div>

<span class="section-eyebrow">07 — 패럴랙스 보정</span>

</div>

# 패럴랙스 보정: 반사 벡터를 다시 조준한다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
큐브맵은 캡처 위치라는 한 점에서 찍혔다. 픽셀이 캡처 위치에서 떨어져 있으면(대부분 그렇다) 반사 벡터를 그대로 큐브맵 조회에 쓰면 반사가 엉뚱한 곳을 비춘다. 방 안의 바닥이 방 반대편 벽 대신 벽 너머의 무언가를 비추는 식이다. 보정 아이디어는 간단하다: <strong>캡처의 프록시 지오메트리(박스 또는 구)에 반사 광선을 실제로 교차시키고, 그 교차점을 캡처 위치에서 바라본 방향으로 큐브맵을 읽는다.</strong>
</p>

<div class="scene-fig">
<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="박스 패럴랙스 보정: 픽셀 P에서 나간 반사 벡터 R이 박스 벽에 교차하고, 그 교차점을 캡처 위치 C에서 본 방향으로 큐브맵을 읽는다">
<defs>
<marker id="rc-ar" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d6304a"/></marker>
<marker id="rc-ag" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0a8f72"/></marker>
<marker id="rc-ab" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7d92a8"/></marker>
</defs>
<!-- left: wrong (no correction) -->
<rect x="30" y="30" width="290" height="180" rx="8" fill="none" stroke="#7d92a8" stroke-width="1.5" stroke-dasharray="7 5"/>
<circle cx="175" cy="120" r="5" fill="#4338ca"/>
<text x="175" y="108" text-anchor="middle" fill="#4338ca" font-size="12" font-style="italic">C (캡처 위치)</text>
<circle cx="80" cy="185" r="5" fill="#b07d00"/>
<text x="80" y="203" text-anchor="middle" fill="#b07d00" font-size="12" font-style="italic">P (픽셀)</text>
<line x1="80" y1="185" x2="255" y2="55" stroke="#7d92a8" stroke-width="1.6" marker-end="url(#rc-ab)"/>
<line x1="175" y1="120" x2="285" y2="38" stroke="#7d92a8" stroke-width="1.4" stroke-dasharray="3 3" marker-end="url(#rc-ab)"/>
<text x="175" y="240" text-anchor="middle" fill="#43566b" font-size="12">보정 없음: P의 R을 C에서 그대로 쓰면 다른 곳을 읽는다</text>
<!-- right: corrected -->
<rect x="400" y="30" width="290" height="180" rx="8" fill="none" stroke="#0a8f72" stroke-width="1.5" stroke-dasharray="7 5"/>
<circle cx="545" cy="120" r="5" fill="#4338ca"/>
<text x="545" y="108" text-anchor="middle" fill="#4338ca" font-size="12" font-style="italic">C</text>
<circle cx="450" cy="185" r="5" fill="#b07d00"/>
<text x="450" y="203" text-anchor="middle" fill="#b07d00" font-size="12" font-style="italic">P</text>
<line x1="450" y1="185" x2="606" y2="30" stroke="#d6304a" stroke-width="1.8" marker-end="url(#rc-ar)"/>
<circle cx="606" cy="30" r="4.5" fill="#d6304a"/>
<text x="630" y="26" fill="#d6304a" font-size="12" font-style="italic">P + t·R</text>
<line x1="545" y1="120" x2="601" y2="37" stroke="#0a8f72" stroke-width="1.8" stroke-dasharray="5 3" marker-end="url(#rc-ag)"/>
<text x="545" y="240" text-anchor="middle" fill="#43566b" font-size="12">보정: R을 박스에 교차시키고, 교차점을 C에서 본 방향으로 조회</text>
</svg>
<div class="scene-cap">패럴랙스 보정의 기하. 박스 캡처는 영향 볼륨이 대개 방의 벽과 일치하므로, 교차점 재투영만으로 벽·바닥의 반사가 제자리에 붙는다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>박스</strong>(<code>GetLookupVectorForBoxCapture</code>)는 광선을 박스의 로컬 공간([-1,1]³ 단위 박스)으로 옮긴 뒤 slab 교차로 나가는 지점을 찾는다. 축마다 두 평면과의 교차 t를 구해 <code>min(max(...))</code>로 줄이면 끝이라 분기가 없다:
</p>

<div class="code-block"><div class="code-lang">HLSL — ReflectionEnvironmentShared.ush GetLookupVectorForBoxCapture (핵심)</div><span class="cm">// [-1,1]³ 단위 박스의 로컬 공간에서 slab 교차</span>
<span class="kw">float3</span> FirstPlaneIntersections  = InvRayDir * (<span class="num">-1.0</span> - LocalRayStart);
<span class="kw">float3</span> SecondPlaneIntersections = InvRayDir * ( <span class="num">1.0</span> - LocalRayStart);
<span class="kw">float3</span> FurthestPlaneIntersections = <span class="fn">max</span>(FirstPlaneIntersections, SecondPlaneIntersections);
<span class="kw">float</span> Intersection = <span class="fn">min</span>(FurthestPlaneIntersections.x, <span class="fn">min</span>(FurthestPlaneIntersections.y, FurthestPlaneIntersections.z));

<span class="kw">float3</span> IntersectPosition = WorldPosition + Intersection * ReflectionVector;
<span class="kw">float3</span> ProjectedCaptureVector = IntersectPosition - (BoxCapturePosition + LocalCaptureOffset);

<span class="cm">// Shrink the box by the transition distance so that the fade happens inside the box influence area</span>
<span class="kw">float</span> BoxDistance = <span class="fn">ComputeDistanceFromBoxToPoint</span>(-(BoxScales.xyz - <span class="num">.5f</span> * BoxScales.w),
                      BoxScales.xyz - <span class="num">.5f</span> * BoxScales.w, LocalRayStart * BoxScales.xyz);
DistanceAlpha = <span class="num">1.0</span> - <span class="fn">smoothstep</span>(<span class="num">0</span>, <span class="num">.7f</span> * BoxScales.w, BoxDistance);</div>

<p style="color:var(--text2);line-height:1.85;">
마지막 두 줄이 06장의 ② 축, 공간 페이드다. <code>BoxScales.w</code>가 에디터의 <strong>BoxTransitionDistance</strong>(기본 100)인데, 박스를 그만큼 안쪽으로 수축시킨 가상의 박스에서부터 거리를 재서 <strong>페이드가 영향 볼륨 안쪽에서 완결</strong>되게 한다. 이 거리 함수는 이름과 달리 유클리드 거리가 아니다. 소스 자체에 <code>//@todo - this is actually incorrect, it gives manhattan distance</code>라는 주석이 붙어 있다. 페이드용이라 시각적으로 문제가 안 되어 십 년 넘게 그대로다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>구</strong>(<code>GetLookupVectorForSphereCapture</code>)는 같은 아이디어를 이차방정식으로 푼다. <code>t² + 2(R·L)t + (|L|² − r²) = 0</code>의 먼 근 <code>t = √Δ − b</code>로 교차점을 얻는다. 페이드는 정규화 거리의 smoothstep인데, 컴파일러 호환성 문제로 수동 전개되어 있다:
</p>

<div class="formula">x = saturate(2.5·(d/r) − 1.5)
DistanceAlpha = 1 − x²(3 − 2x)        ≡ 1 − smoothstep(0.6, 1.0, d/r)

→ 반경의 60%까지는 알파 1, 100%에서 0.
→ 판별식 Δ &lt; 0 (반사 광선이 구를 아예 안 뚫는 경우)이면 알파가 초기값 0으로 남아 기여가 완전히 사라진다.</div>

<p style="color:var(--text2);line-height:1.85;">
두 함수 모두에 등장하는 <code>LocalCaptureOffset</code>은 에디터의 <strong>CaptureOffset</strong> 프로퍼티다. 큐브맵을 실제로 렌더한 카메라 위치가 캡처 액터의 중심과 다를 수 있으므로(예: 볼륨 중심이 벽 안에 박혀 있을 때), 조회 벡터의 원점을 실제 촬영 지점으로 되돌리는 보정이다.
</p>

<span class="section-eyebrow">08 — 마무리 셰이딩</span>

</div>

# 마무리: EnvBRDF, AO, 그리고 라이트맵 믹싱

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
합성 함수가 돌려준 색에는 아직 재질이 반영되어 있지 않다. 지금까지는 "반사 방향에서 오는 빛"만 모았다. 01장 split-sum의 뒷조각인 <strong>EnvBRDF</strong>가 마지막에 곱해진다. 시선 각도(NoV)와 러프니스로 2D LUT(PreIntegratedGF)를 읽어 프레넬과 지오메트리 항의 사전 적분을 가져오는 두 줄짜리 함수다:
</p>

<div class="code-block"><div class="code-lang">HLSL — BRDF.ush EnvBRDF</div><span class="kw">half3</span> <span class="fn">EnvBRDF</span>(<span class="kw">half3</span> SpecularColor, <span class="kw">half</span> Roughness, <span class="kw">half</span> NoV)
{
    <span class="cm">// Importance sampled preintegrated G * F</span>
    <span class="kw">float2</span> AB = <span class="fn">Texture2DSampleLevel</span>(PreIntegratedGF, PreIntegratedGFSampler, <span class="kw">float2</span>(NoV, Roughness), <span class="num">0</span>).rg;

    <span class="cm">// Anything less than 2% is physically impossible and is instead considered to be shadowing</span>
    <span class="kw">return</span> SpecularColor * AB.x + <span class="fn">saturate</span>(<span class="num">50.0</span> * SpecularColor.g) * AB.y;
}</div>

<p style="color:var(--text2);line-height:1.85;">
곱해지는 위치가 중요하다. 캡처에만 곱하는 게 아니라 <strong>SSR + 캡처 + 스카이라이트를 전부 합친 최종 색에 딱 한 번</strong> 곱한다. 어떤 소스에서 왔든 같은 재질 응답을 받아야 소스 간 밝기가 이어지기 때문이다. 모바일 등 LUT가 부담스러운 경로에는 다항식 근사 <code>EnvBRDFApprox</code>(Lazarov 2013)가 있고, 완전 러프 처리는 <code>DiffuseColor += SpecularColor * 0.45</code>라는 한 줄로 접는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
AO는 종류별로 들어가는 지점이 다르다. 설계 원칙은 <code>GatherRadiance</code>의 주석 한 줄에 있다: "should be applied to reflection captures and skylight specular, <strong>but not SSR</strong>". 화면 공간 AO(SSAO×GBufferAO)는 06장 ③에서 <strong>알파 예산</strong>을 깎는 방식이라 SSR 이후의 모든 소스에 영향을 주고, distance field AO는 bent normal과 반사 콘의 교차 근사로 만든 별도 항이라 캡처와 스카이에만 곱해진다. SSR은 이미 실제 씬을 추적한 결과라 또 가리면 이중 차폐가 되기 때문이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
마지막 재료가 <strong>라이트맵 믹싱</strong>이다. 캡처 큐브맵은 방 하나를 한 점에서 찍은 것이라 <strong>방향 정보는 풍부하지만 공간 정보는 한 점뿐</strong>이고, 라이트맵은 반대로 <strong>공간 정보는 텍셀 단위로 정밀하지만 방향 정보가 뭉개져</strong> 있다. 그래서 러프한 표면에서는 캡처의 색을 "그 픽셀의 라이트맵 밝기 ÷ 캡처의 평균 밝기" 비율로 스케일해서, 큐브맵의 저주파(공간) 성분을 라이트맵의 것으로 갈아 끼운다. 03장에서 구워 둔 AverageBrightness가 이 분모다:
</p>

<div class="code-block"><div class="code-lang">HLSL — ReflectionEnvironmentShared.ush ComputeMixingWeight</div><span class="cm">// Mirror surfaces should have no mixing, so they match reflections from other sources (SSR, planar reflections)</span>
<span class="kw">half</span> MixingAlpha = <span class="fn">smoothstep</span>(<span class="num">0</span>, <span class="num">1</span>, <span class="fn">saturate</span>(Roughness * MixingScaleBias.x + MixingScaleBias.y));

<span class="cm">// We have high frequency directional data but low frequency spatial data in the envmap.</span>
<span class="cm">// We have high frequency spatial data but low frequency directional data in the lightmap.</span>
<span class="cm">// This is only done with luma so as to not get odd color shifting.</span>
<span class="kw">half</span> MixingWeight = IndirectIrradiance / <span class="fn">max</span>(AverageBrightness, <span class="num">.0001f</span>);

<span class="kw">return</span> <span class="fn">lerp</span>(<span class="num">1.0f</span>, MixingWeight, MixingAlpha);</div>

<p style="color:var(--text2);line-height:1.85;">
기본값(<code>r.ReflectionEnvironmentBeginMixingRoughness</code> 0.1, End 0.3)에서 러프니스 0.1 이하는 믹싱이 없고(거울면이 라이트맵 밝기로 스케일되면 SSR·플래너와 밝기가 어긋나므로), 0.3부터는 완전히 믹싱된다. 색이 아니라 휘도 비율만 쓰는 것도 색 시프트를 피하려는 선택이다. 스카이라이트 폴백도 정적 스카이라면 이 믹싱의 분모에 자기 평균 밝기를 보태고, 동적 스카이라면 믹싱을 우회해 마지막에 더해진다.
</p>

<span class="section-eyebrow">09 — 캡처의 한계</span>

</div>

# 한계: 캡처가 원리적으로 못 하는 것

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
지금까지 따라온 경로는 전부 "미리 찍어 둔 큐브맵 한 장을 방향으로 조회한다"는 한 문장에서 나온다. 싼 이유가 거기에 있고, 한계도 전부 거기서 나온다. 큐브맵에 들어 있는 것은 <strong>캡처 지점에서 그 방향으로 보이던 색</strong>뿐이다. 그 색이 어디서 온 빛인지도, 지금도 그런지도, 지금 이 픽셀에서 그 방향이 보이기는 하는지도 들어 있지 않다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>가시성(visibility)을 따지지 않는다.</strong> 합성 루프가 캡처를 쓸지 말지 정하는 조건은 "픽셀이 이 캡처의 영향 볼륨 안에 있는가" 하나뿐이다(05~06장). 픽셀과 캡처 사이에 벽이 있는지는 아무도 검사하지 않는다. 그래서 벽 하나를 사이에 둔 옆방 바닥이 이 방의 큐브맵을 그대로 읽고, 옆방의 붉은 벽이 이 방 바닥에 비친다. reflection leaking이라고 부르는 현상이다. 07장의 패럴랙스 보정도 조회 방향만 바꿀 뿐 무엇이 가리고 있는지는 모르고, 08장의 AO와 06장의 알파 예산은 결과를 덜 눈에 띄게 눌러 줄 뿐이다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 720 260" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="왼쪽: 벽 너머의 픽셀이 캡처 큐브맵을 그대로 읽어 옆방의 붉은 벽이 비치는 그림. 오른쪽: 광선을 쏘면 벽에 먼저 맞아 옆방 색이 오지 않는 그림">
<defs>
<marker id="rcl-r" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d6304a"/></marker>
<marker id="rcl-i" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4338ca"/></marker>
<marker id="rcl-g" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0a8f72"/></marker>
</defs>
<!-- left: capture -->
<rect x="30" y="40" width="300" height="150" fill="none" stroke="#7d92a8" stroke-width="1.5"/>
<rect x="30" y="190" width="300" height="10" fill="#d9a441"/>
<rect x="185" y="40" width="10" height="150" fill="#6b7280"/>
<rect x="30" y="60" width="10" height="130" fill="#d6304a"/>
<rect x="48" y="55" width="212" height="140" rx="6" fill="none" stroke="#4338ca" stroke-width="1.3" stroke-dasharray="6 4"/>
<text x="154" y="50" fill="#4338ca" font-size="11" text-anchor="middle">영향 볼륨</text>
<circle cx="110" cy="112" r="5" fill="#4338ca"/>
<text x="110" y="102" fill="#4338ca" font-size="11" text-anchor="middle" font-style="italic">C</text>
<circle cx="240" cy="184" r="5" fill="#b07d00"/>
<text x="248" y="180" fill="#b07d00" font-size="11" font-style="italic">P</text>
<line x1="234" y1="180" x2="120" y2="118" stroke="#4338ca" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#rcl-i)"/>
<line x1="102" y1="110" x2="48" y2="96" stroke="#d6304a" stroke-width="1.8" marker-end="url(#rcl-r)"/>
<text x="180" y="228" fill="var(--text2)" font-size="12" text-anchor="middle">영향 볼륨 안이면, 벽이 가로막고 있어도 그대로 읽는다</text>
<!-- right: ray -->
<rect x="390" y="40" width="300" height="150" fill="none" stroke="#7d92a8" stroke-width="1.5"/>
<rect x="390" y="190" width="300" height="10" fill="#d9a441"/>
<rect x="545" y="40" width="10" height="150" fill="#6b7280"/>
<rect x="390" y="60" width="10" height="130" fill="#d6304a"/>
<circle cx="600" cy="184" r="5" fill="#b07d00"/>
<text x="608" y="180" fill="#b07d00" font-size="11" font-style="italic">P</text>
<line x1="594" y1="180" x2="558" y2="160" stroke="#0a8f72" stroke-width="1.8" marker-end="url(#rcl-g)"/>
<circle cx="555" cy="158" r="4.5" fill="#0a8f72"/>
<text x="640" y="140" fill="#0a8f72" font-size="12" text-anchor="middle">벽에서 멈춘다</text>
<text x="540" y="228" fill="var(--text2)" font-size="12" text-anchor="middle">광선은 벽에 먼저 맞으므로 옆방 색이 애초에 오지 않는다</text>
</svg>
<div class="scene-cap">같은 상황을 캡처(왼쪽)와 광선(오른쪽)으로 처리했을 때. 캡처는 픽셀 P가 볼륨 안에 있다는 이유만으로 캡처 지점 C의 큐브맵을 읽고, 그 큐브맵에는 벽 너머 붉은 벽의 색이 들어 있다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>패럴랙스는 프록시 도형까지만 맞다.</strong> 07장의 보정이 광선을 교차시키는 상대는 실제 지오메트리가 아니라 박스 하나 또는 구 하나다. 방이 직육면체에 가까우면 잘 맞지만 기둥·계단·가구가 있으면 반사가 어긋난다. 결국 캡처를 촘촘히 놓아 감추는 수밖에 없고, 그러면 겹침 처리(06장)와 굽는 시간(02장의 6N번 GPU 싱크)이 함께 늘어난다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>찍은 순간에 멈춰 있다.</strong> 베이크 캡처는 레벨 빌드 때 구워지고, 쿠킹된 게임에서는 GPU에 올린 뒤 CPU 사본을 버린다(04장). 움직이는 캐릭터도, 열린 문도, 낮에서 밤으로 바뀐 조명도 반사에 나타나지 않는다. 게다가 캡처를 렌더할 때 모든 표면의 러프니스를 1로 강제하고 포스트 프로세싱을 끄기 때문에(02장), 반사 속 세상은 실제 화면보다 밋밋하다. <strong>매끈한 반사도 불가능하다.</strong> 해상도 128 기준으로 mip 0이 이미 러프니스 0.056 상당이라(03장), 그보다 매끈한 거울면은 캡처로 표현할 수 없다.
</p>

<div class="data-table">
<table>
<tr><th>한계</th><th>어디서 생기나</th><th>이 시스템의 완화책</th><th>광선을 쏘면</th></tr>
<tr><td>가시성 판정이 없다 (leaking)</td><td>영향 볼륨 안이면 무조건 샘플 (05~06장)</td><td>AO와 알파 예산으로 눌러 준다 (08장)</td><td>벽에 먼저 맞으므로 생기지 않는다</td></tr>
<tr><td>패럴랙스가 근사다</td><td>박스/구 교차로 대체 (07장)</td><td>캡처를 촘촘히 배치</td><td>맞은 지점이 곧 정답</td></tr>
<tr><td>동적 물체·조명이 없다</td><td>빌드 타임 베이크, CPU 사본 폐기 (04장)</td><td>런타임 캡처 (11장)</td><td>매 프레임 최신 씬을 추적</td></tr>
<tr><td>거울면을 못 만든다</td><td>mip 0 = 러프니스 0.056 (03장)</td><td>해상도 상향, SSR·플래너 병행</td><td>러프니스 0도 그대로</td></tr>
<tr><td>공간 정보가 한 점뿐</td><td>큐브맵은 캡처 위치에서 찍힘 (01장)</td><td>라이트맵 믹싱으로 저주파 보정 (08장)</td><td>픽셀마다 자기 위치에서 추적</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
표의 마지막 열이 말해 주듯, 이 한계들은 하나같이 "빛이 실제로 어디서 왔는지 모른다"는 한 가지 원인에서 나오고, 광선을 실제로 쏘면 대부분 사라진다. 물론 공짜는 아니다. 씬 전체의 <a href="/raytracing-shader">BVH를 매 프레임 유지</a>해야 하고, 광선이 맞은 지점을 다시 셰이딩해야 하고, 적은 샘플에서 오는 노이즈를 <a href="/denoising">디노이징</a>으로 메워야 한다. 캡처는 그 비용을 조회 두 번으로 바꾼 대신 위의 한계를 받아들인 쪽이다. 다음 장에서는 그 비용을 감당하기로 한 <a href="/lumen">Lumen</a>이 켜졌을 때 이 시스템이 어디까지 밀려나고, 그럼에도 어디에 남는지를 본다.
</p>

<span class="section-eyebrow">10 — Lumen 시대의 캡처</span>

</div>

# Lumen 시대의 캡처: 누가 언제 쓰는가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
UE5의 기본 반사(Reflection)가 Lumen이 된 지금, 이 시스템은 어디에 남아 있을까. 반사 소스별로 06장의 패스가 어떻게 달라지는지 표로 정리하면:
</p>

<div class="data-table">
<table>
<tr><th>구성</th><th>합성 패스</th><th>캡처의 운명</th></tr>
<tr><td>Lumen GI + Lumen Reflections</td><td><strong>아예 스킵</strong> (뷰 루프에서 <code>continue</code>)</td><td>불투명면에 미적용(러프 반사는 Screen Probe Gather의 rough specular가 대체)</td></tr>
<tr><td>Lumen Reflections 단독 (GI는 다른 것)</td><td>돎 (LUMEN_STANDALONE 퍼뮤테이션)</td><td>Lumen이 러프니스 페이드로 못 채운 잔여 알파만 캡처+스카이</td></tr>
<tr><td>SSR</td><td>돎</td><td>SSR 잔여 알파를 캡처가 채움 (06장의 기본 시나리오)</td></tr>
<tr><td>None</td><td>돎</td><td>캡처+스카이가 반사 전체</td></tr>
<tr><td>Path Tracer</td><td>스킵</td><td>사용 안 함 (PathTracing.cpp에 캡처 참조 0건)</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
첫 줄에서 캡처가 꺼지는 방식은 이렇다. Lumen Reflections가 켜지면 뷰 uniform의 <code>PrecomputedIndirectSpecularColorScale</code>이 <strong>0으로 세팅</strong>되는데(SceneRendering.cpp), 06장의 합성 함수는 캡처 누적이 끝난 직후, 스카이라이트를 더하기 <strong>전</strong>에 이 값을 곱한다. 그래서 캡처를 쓰는 다른 모든 경로(포워드 반투명, 물, 헤어)에서도 캡처 기여만 조용히 0이 되고 스카이 폴백은 살아남는다. 셰이더 퍼뮤테이션 하나 없이 uniform 값 하나로 시스템 전체를 끈 셈이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
캡처가 여전히 쓰이는 자리도 분명하다. <strong>포워드 렌더러</strong>는 프리미티브당 가장 가까운 캡처 하나(<code>FindClosestReflectionCapture</code>)를 GPUScene에 인덱스로 기록해 두고 베이스패스에서 바로 샘플하며, 머티리얼의 "High Quality Reflections" 옵션을 켜면 디퍼드처럼 블렌디드 다중 캡처가 된다. <strong>반투명</strong>은 디퍼드 렌더러에서도 캡처 경로를 기본으로 쓰고(Lumen이 켜져 있으면 Radiance Cache가 우선, 캡처는 폴백), <strong>Single Layer Water</strong>는 수면 깊이로 그리드를 조회해 SSR과 합성한다. <strong>모바일</strong>은 클러스터드 반사를 켜면 데스크톱과 같은 경로, 끄면 프리미티브당 캡처 1개(R11G11B10 인코딩)라는 두 갈래다. 레이트레이싱 쪽에서는 Lumen HWRT의 hit lighting이 레이가 맞은 지점의 2차 반사 근사로 캡처를 쓸 수 있지만 기본은 꺼져 있다(<code>r.Lumen.HardwareRayTracing.HitLighting.ReflectionCaptures</code> = 0).
</p>

<span class="section-eyebrow">11 — 런타임 캡처 (5.8)</span>

</div>

# UE 5.8 소스 트리의 런타임 캡처

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
이 글이 참조한 5.8 소스 트리에는 베이크 캡처와 상호 배타로 동작하는 <strong>런타임 리플렉션 캡처</strong> 시스템이 들어 있다(<code>r.ReflectionCapture.Runtime</code>, 컴포넌트의 <code>bRuntimeCapture</code>). 에픽 공식 배포판의 기능이라기보다 이 트리에 통합된 확장에 가까우므로, 버전에 따라 없거나 다를 수 있다는 전제로 요점만 정리한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
구조는 이렇다. 트랜지언트 <code>ASceneCaptureCube</code> 액터 하나를 스폰해 재사용하면서, 프레임당 큐브 면 1~6개씩(<code>r.ReflectionCapture.Runtime.Timeslice</code>) 타임슬라이스로 캡처를 렌더하고, 여섯 면이 완성된 프레임에만 큐브맵 어레이 슬롯으로 복사한다. 04장의 어레이·uniform buffer·06장의 합성 경로는 그대로 공유하고, <code>CaptureProperties.a</code>의 페이드 알파(<code>FadeInTime</code> 0.5초), 동시 활성 개수 예산(<code>Budget</code> + 히스테리시스), 리프레시 시 옛 큐브맵과 크로스페이드하는 smooth blend 슬롯(어레이 꼬리에 최대 4개 예약) 같은 운영 장치가 붙는다.
</p>

<div class="callout callout-info">
<div class="callout-title">품질의 대가: GGX 프리필터가 없다</div>
<p>런타임 캡처의 밉은 03장의 GGX importance sampling이 아니라 <code>FGenerateMips</code>(큐브맵을 2D 슬라이스 여섯 장으로 취급하는 단순 bilinear 축소)로 만들어진다. 면 경계 처리도, BRDF 정합도 없다. 읽는 쪽은 같은 roughness→mip 매핑을 쓰므로 러프한 표면일수록 베이크 캡처보다 품질이 떨어진다. 매 프레임 갱신 가능한 반사와 프리필터 비용의 맞교환이다.</p>
</div>

<span class="section-eyebrow">정리</span>

</div>

# 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
한 문단으로 정리하면 이렇다. <strong>리플렉션 캡처는 split-sum 근사의 "환경광 조각"을 레벨 빌드 타임에 굽는 시스템이다. 캡처 위치에서 씬을 여섯 번 렌더해(러프니스 1 강제, 알파에 스카이 마스크) GGX importance sampling으로 러프니스별 밉을 만들고, 씬당 하나의 TextureCubeArray와 고정 배열 uniform buffer에 모아, 라이트 그리드에 셀 단위로 추려 넣는다. 픽셀에서는 SSR이 못 채운 알파를 예산 삼아 작은 캡처부터 under 연산으로 쌓고(각 캡처는 박스/구 교차로 반사 벡터를 재조준하고 경계에서 페이드한다), 남은 알파를 스카이라이트가 가져간 뒤, EnvBRDF가 전체에 딱 한 번 곱해진다.</strong>
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">Mip = MaxMip − 2 + 1.2·log₂(R)</div>
<div class="card-title">러프니스가 곧 밉</div>
<div class="card-desc">굽는 쪽과 읽는 쪽이 같은 함수를 공유한다. 해상도 128이면 R&lt;0.056은 표현 불가, 하위 3밉은 사실상 디퓨즈. 스카이라이트도 같은 매핑을 쓴다.</div>
</div>
<div class="card teal">
<div class="card-label">alpha = sky mask</div>
<div class="card-title">두 개의 알파</div>
<div class="card-desc">큐브맵 알파는 "이 방향에 유효한 지오메트리가 있는가", 합성 알파는 "아직 반사가 안 채워진 예산". 둘이 곱해지는 한 줄이 SSR→캡처→스카이 폴백 체인을 만든다.</div>
</div>
<div class="card gold">
<div class="card-label">반경 오름차순</div>
<div class="card-title">정렬이 곧 우선순위</div>
<div class="card-desc">under 연산에서 먼저 온 것이 위. 작은 캡처를 앞에 두는 정렬 하나로 "구체적인 캡처가 이긴다"가 공짜가 된다. 그리드 컬링도 이 순서를 보존한다.</div>
</div>
<div class="card coral">
<div class="card-label">ColorScale = 0</div>
<div class="card-title">Lumen의 스위치</div>
<div class="card-desc">Lumen Reflections가 켜지면 uniform 값 하나가 0이 되어 모든 경로의 캡처 기여만 사라진다. 스카이 폴백과 포워드·반투명·모바일의 자리는 남는다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
핵심 숫자들만 모아 두자. 해상도 128 · 밉 8장 · FP16 RGBA · 캡처당 약 1MB, 프리필터 샘플 32/64, 상한 341장(2048÷6), 구 페이드는 반경 60%부터, 박스 페이드는 0.7·TransitionDistance, 믹싱은 러프니스 0.1~0.3 구간, EnvBRDF는 마지막 한 번. 반사(Reflection) 시스템의 계보에서 보면 캡처는 <a href="/lumen">Lumen</a> 이전 세대의 주력이었지만, "화면 밖을 아는 가장 싼 폴백"이라는 자리는 지금도 대체되지 않았다. SSR의 구멍을 메우는 것도, 포워드·반투명·모바일의 반사도, Lumen이 꺼진 저사양 스케일러빌리티의 반사도 결국 이 큐브맵 어레이에서 나온다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card blue">
<div class="card-label">원 발표 (2013)</div>
<div class="card-title">Real Shading in Unreal Engine 4</div>
<div class="card-desc"><a href="https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf">Karis, SIGGRAPH 2013 course notes</a>: split-sum 근사, prefiltered environment map, EnvBRDF LUT와 그 근사(Lazarov 2013 인용)의 출처. 이 글의 03·08장이 코드로 확인한 내용의 원전.</div>
</div>
<div class="card purple">
<div class="card-label">패럴랙스 보정</div>
<div class="card-title">Image-based Lighting approaches and parallax-corrected cubemap</div>
<div class="card-desc"><a href="https://seblagarde.wordpress.com/2012/09/29/image-based-lighting-approaches-and-parallax-corrected-cubemap/">Lagarde &amp; Zanuttini (SIGGRAPH 2012 talk / 블로그)</a>: 프록시 지오메트리 교차로 반사 벡터를 재투영하는 기법의 대표 문헌. 07장의 박스/구 교차가 이 계열이다.</div>
</div>
<div class="card teal">
<div class="card-label">엔진 소스</div>
<div class="card-title">언리얼엔진 5.8</div>
<div class="card-desc"><code>ReflectionEnvironmentCapture.cpp</code>, <code>ReflectionEnvironment.cpp</code>, <code>IndirectLightRendering.cpp</code>, <code>RendererScene.cpp</code>, <code>LightGridInjection.cpp/.usf</code>, <code>ReflectionEnvironmentShaders.usf</code>, <code>ReflectionEnvironmentPixelShader.usf</code>, <code>ReflectionEnvironmentComposite.ush</code>, <code>ReflectionEnvironmentShared.ush</code>, <code>BRDF.ush</code>. 이 글의 모든 코드 인용의 1차 출처.</div>
</div>
<div class="card gold">
<div class="card-label">함께 읽기</div>
<div class="card-title">이 블로그의 이웃 글</div>
<div class="card-desc"><a href="/ssr">SSR</a>(이 글의 06장에서 캡처가 이어받는 알파를 만드는 쪽), <a href="/spherical-harmonics">Spherical Harmonics</a>(스카이라이트 디퓨즈의 SH 경로), <a href="/lumen">Lumen</a>(캡처를 대체한 실시간 GI/반사), <a href="/raytracing-gi">Ray Tracing GI</a>. 캡처가 폴백으로 등장하는 지점들을 각 글에서 반대편 시점으로 볼 수 있다.</div>
</div>
</div>
</div>
