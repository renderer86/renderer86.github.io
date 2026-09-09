---
layout: post
title: "선형 파이프라인, linear와 sRGB: 텍스처의 sRGB 체크박스에서 HDR 디스플레이 출력까지"
icon: paper
permalink: color-space
categories: Rendering
tags: [ComputerGraphics, Rendering, ColorSpace, sRGB, LinearWorkflow, HDR, Tonemapping, UnrealEngine]
excerpt: "텍스처 임포트 창의 sRGB 체크박스 하나를 잘못 두면 화면 밝기가 통째로 달라진다. 그 체크박스가 무엇을 하는지 끝까지 따라가면, 8bit에 색을 담는 압축 기법에서 시작해 하드웨어 샘플러의 자동 디코드, float 포맷의 scene color, ACES 톤커브, 그리고 모니터가 다시 빛으로 바꾸는 마지막 단계까지 하나의 파이프라인이 드러난다. 이 글은 감마가 왜 생겼는지, 왜 조명과 블렌딩과 밉맵은 반드시 linear에서 계산해야 하는지를 실제 숫자로 확인하고, 언리얼엔진 5.8 소스에서 그 규칙이 어디에 어떻게 박혀 있는지를 UTexture::SRGB부터 TexCreate_SRGB, DXGI_FORMAT_BC1_UNORM_SRGB, FLinearColor의 룩업 테이블, PF_FloatRGBA와 PreExposure, PostProcessCombineLUTs의 shaper, WorkingColorSpace 유니폼 버퍼까지 따라간다. 마지막 장은 linear와 sRGB를 다루는 코드를 쓸 때 실수하지 않기 위한 체크리스트와, UI가 뿌옇게 뜨거나 렌더타깃 라운드트립이 어긋나는 전형적 버그의 진단법이다."
back_color: "#ffffff"
img_name: "color-space-core-sketch.webp"
thumbnail: "assets/img/post/color-space/color-space-core-sketch.webp"
toc: false
show: true
new: true
series: -1
index: 38
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - 텍스처 임포트할 때 sRGB 체크박스를 켜야 할지 꺼야 할지를 매번 감으로 정해 온 분
> - `FColor`와 `FLinearColor`가 왜 둘 다 있고 왜 서로 암묵적으로 변환되지 않는지 궁금했던 분
> - 렌더타깃에 그린 색을 다시 읽었더니 값이 달라져 있어서 당황한 적이 있는 분
> - UMG 색이 에디터 컬러 피커에서 고른 것보다 뿌옇거나 밝게 나오는 이유를 알고 싶은 분
> - scene color가 왜 FP16이어야 하고 `PreExposure`가 왜 곱해져 있는지 확인하고 싶은 분
> - 톤매핑을 "HDR을 LDR로 줄이는 것"까지만 알고, 그 뒤의 출력 인코딩은 흐릿하게 남겨 둔 분
>
> **이 글로 알 수 있는 내용**
>
> - 감마가 CRT의 물리적 특성 때문에 생겼는데 사람 눈의 지각 특성 때문에 지금까지 남은 이유, 그리고 그 둘이 우연히 맞아떨어진 덕분에 sRGB가 압축 기법이 된 사정
> - 8bit로 색을 저장할 때 sRGB 인코딩이 어두운 쪽 계조를 linear보다 약 13배 촘촘하게 쓴다는 계산
> - 흑백 체커보드의 밉맵을 sRGB 값에서 평균내면 결과가 2.34배 어두워진다는 것을 포함해, 덧셈·알파 블렌딩·필터링이 linear에서만 옳은 이유의 구체적 숫자
> - HDR 렌더링이 linear를 전제하는 진짜 이유: 노출과 밝기 배수가 단순 곱셈이 되어야 하고, 값의 상한이 없어야 한다
> - 선형성(전달 함수)과 색공간(primaries)이 완전히 별개의 속성이라는 것, 그리고 UE5의 Working Color Space가 그중 색공간을 다루는 시스템이라는 것
> - `UTexture::SRGB` 한 비트가 `TexCreate_SRGB`를 거쳐 `DXGI_FORMAT_BC1_UNORM_SRGB`가 되고, 셰이더의 `ProcessMaterialColorTextureLookup`은 아무 일도 하지 않는다는 전체 체인
> - `FLinearColor(FColor)`가 쓰는 256칸 룩업 테이블의 정체와, `FColor(FLinearColor)`가 private으로 막혀 링크 에러를 내는 이유
> - scene color가 `PF_FloatRGBA` + `PreExposure` 곱이고, GBuffer의 BaseColor만 하드웨어 sRGB를 쓰는 이유
> - 톤커브와 디스플레이 인코딩이 톤매퍼 셰이더가 아니라 3D LUT에 미리 구워진다는 UE5.8의 구조, 그리고 LUT 좌표에 log나 PQ shaper를 쓰는 이유
> - linear와 sRGB가 섞이는 코드를 작성할 때의 판단 기준과, UI가 뿌옇게 뜨거나 렌더타깃 값이 어긋나는 버그의 진단 순서
>
<br>

{% include research-post-style.html %}

<div class="research-post">
<span class="section-eyebrow">00 — 개요</span>
</div>

# sRGB 옵션 하나가 화면 밝기를 바꾼다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
텍스처를 임포트하면 디테일 패널에 <code>sRGB</code>라는 체크박스가 있다. albedo 텍스처는 켜 두고 roughness 맵은 꺼야 한다는 것<span class="fn-note"><input type="checkbox" id="fn-srgbflag" class="fn-toggle"><label for="fn-srgbflag" class="fn-ref">1</label><span class="fn-body"><strong>albedo는 켜고 roughness는 끄는 이유:</strong> albedo(base color)는 사람이 보는 색을 8bit로 저장한 이미지라 제작 툴이 sRGB 곡선으로 인코딩해 저장한다. 그래서 GPU가 읽을 때 디코드해서 linear로 되돌려야 하고, 그 디코드를 켜는 것이 이 체크박스다. roughness·metallic·normal·mask는 색이 아니라 셰이더가 그대로 쓰는 수치라서 0.5는 정확히 0.5여야 하고, 곡선을 씌우거나 벗겨서는 안 된다. 체크박스를 켜 두면 하드웨어가 저장값 0.5를 0.216으로 디코드해서 roughness 0.5가 0.216이 되고 표면이 실제보다 훨씬 매끈해진다. 이 체크박스가 GPU 포맷까지 내려가는 과정과 샘플러 타입 검사는 07장에서 확인한다.</span></span> 정도는 알고 있다. 그런데 그 체크박스가 정확히 무엇을 바꾸는지 설명해 보라고 하면 쉽지 않다. 텍스처 데이터가 바뀌는 것일까, 셰이더에 코드가 추가되는 것일까, 아니면 GPU 설정이 달라지는 것일까. 그 체크박스가 바꾸는 것은 GPU에 올라가는 텍스처 포맷이다. 그래서 이 한 비트를 잘못 두어도 셰이더 코드에는 아무 변화가 없고, 어떤 경고도 없이 화면 밝기만 어긋난다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 글은 그 체크박스에서 출발해, 한 프레임의 렌더링 패스가 linear와 sRGB 중 어느 쪽에서 연산되는지 전체 경로를 따라간다. 텍스처에서 값을 읽는 순간부터 모니터가 그 값을 빛으로 바꾸는 마지막 순간까지 색은 최소 세 번 공간을 옮긴다. 저장용으로 인코딩된 공간에서 계산용 linear 공간으로, 계산이 끝나면 다시 디스플레이용 인코딩 공간으로. 이 세 구간의 경계를 누가 담당하는지, 어떤 경계는 하드웨어가 공짜로 처리하고 어떤 경계는 프로그래머가 직접 써야 하는지가 이 글의 내용이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
순서는 이렇다. 감마라는 것이 왜 생겼는지(01장), sRGB 곡선<span class="fn-note"><input type="checkbox" id="fn-srgbcurve" class="fn-toggle"><label for="fn-srgbcurve" class="fn-ref">2</label><span class="fn-body"><strong>sRGB 곡선:</strong> 이 글에서 "sRGB 곡선"은 linear 밝기 L(0~1)을 8bit 저장값으로 바꾸는 sRGB 규격(IEC 61966-2-1)의 인코딩 함수 그래프를 말한다. 흔히 "감마 2.2"라고 부르는 곡선과 거의 같은 모양이지만 정확히 같지는 않다. 인코딩은 L이 0.0031308 이하이면 12.92 × L의 직선이고, 그 위에서는 1.055 × L<sup>1/2.4</sup> − 0.055의 지수 곡선이다. 디코드는 그 역함수다. 지수는 1/2.4인데 직선 구간과 1.055 배율 때문에 전체 모양은 대략 1/2.2 제곱에 가깝다. 그래서 "감마 2.2"는 sRGB 곡선의 근사치이고, 둘의 차이는 어두운 영역에서 가장 크다. 정확한 모양과 그래프는 02장에 있다.</span></span>의 정확한 모양과 그것이 8bit에서 하는 일(02장), 조명과 블렌딩과 밉맵이 왜 linear에서만 옳은지를 실제 숫자로(03장), HDR 렌더링이 linear를 전제하는 이유(04장), 그리고 선형성과 색공간이 별개의 속성이라는 것(05장)까지가 이론이다. 06장에서 언리얼엔진 파이프라인의 전체 경로를 먼저 그려 보고, 07장부터 11장까지 UE 5.8 소스로 각 구간을 확인한다. 마지막 12장에 이르면 실무에서 실제로 확인해야 하는 내용까지 이어진다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글에서 쓰는 말</div>
<p><strong>linear</strong>는 값이 빛의 물리량에 정비례하는 상태를 말한다. 값이 2배면 광자 수도 2배다. <strong>sRGB</strong>는 그 값을 8bit에 담기 위해 비선형 곡선으로 눌러 놓은 상태를 말한다. 이 글에서 "인코딩"은 linear에서 sRGB 쪽으로 가는 방향, "디코드"는 그 반대를 뜻한다. 색을 다루는 코드에서 버그가 나는 이유는 거의 항상 "지금 이 변수가 어느 쪽인지" 를 착각하는 것이고, 그래서 이 글은 코드를 볼 때마다 그 질문을 반복한다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">01 — 유래</span>
</div>

# 원래 감마값은 CRT 모니터 때문에 나왔다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
감마 보정을 설명하는 글은 보통 CRT<span class="fn-note"><input type="checkbox" id="fn-crt" class="fn-toggle"><label for="fn-crt" class="fn-ref">3</label><span class="fn-body"><strong>CRT(Cathode Ray Tube, 음극선관):</strong> 평면 디스플레이 이전에 쓰였던 브라운관 모니터. 전자총이 형광면을 때려서 빛을 내는데, 전자를 가속하는 전압과 실제로 나오는 빛의 양이 비례하지 않고 대략 2.2제곱 관계였다.</span></span> 이야기부터 시작한다. 브라운관에 입력 전압을 2배로 올려도 화면이 2배 밝아지지 않고 대략 4.6배 밝아졌다. 지수로 쓰면 밝기 ≈ 전압<sup>2.2</sup> 이다. 그래서 방송국은 카메라에서 나온 신호를 미리 2.2의 역수로 눌러서 보냈고, 브라운관이 이를 다시 2.2제곱으로 펴서 원래 밝기를 복원했다. 신호를 누르는 쪽을 OETF, 펴는 쪽을 EOTF<span class="fn-note"><input type="checkbox" id="fn-eotf" class="fn-toggle"><label for="fn-eotf" class="fn-ref">4</label><span class="fn-body"><strong>OETF / EOTF(Opto-Electronic / Electro-Optical Transfer Function):</strong> 빛을 신호로 바꾸는 함수와 신호를 빛으로 바꾸는 함수. 카메라 쪽이 OETF(인코딩), 디스플레이 쪽이 EOTF(디코드)다. 통칭해서 전달 함수(transfer function)라고 부른다. sRGB, Rec.709, PQ, HLG는 전부 전달 함수의 이름이다.</span></span> 라고 부른다.
</p>

<p style="color:var(--text2);line-height:1.85;">
여기까지만 들으면 감마는 낡은 하드웨어의 잔재이고, 브라운관이 사라진 지금은 없어져야 할 것처럼 보인다. 그런데 감마는 사라지지 않았고, 사라질 수도 없다. <strong>두 번째 이유가 있기 때문이다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
사람 눈은 밝기 차이를 절대량이 아니라 비율로 느낀다. 캄캄한 방에서 촛불 하나를 켜면 확실히 밝아진 것을 느끼지만, 이미 촛불 100개가 켜진 방에서 하나를 더 켜면 차이를 못 느낀다. 더한 빛의 양은 똑같은데 지각은 다르다. 그래서 눈은 어두운 영역의 미세한 차이에 훨씬 민감하고, 밝은 영역에서는 둔감하다. 이 특성은 물리적 밝기를 대략 2.2의 역수 정도로 누른 곡선을 따르는데, <strong>공교롭게도 CRT를 보정하기 위해 넣었던 곡선과 거의 같은 모양이다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
이 우연이 오늘의 파이프라인을 만들었다. CRT 시절의 인코딩 곡선은 사실 지각적으로 균일한 스케일이기도 했으므로, 그 곡선으로 8bit에 값을 담으면 사람이 보기에 계조가 고르게 배분된다. 즉 감마는 하드웨어 보정에서 출발했지만 지금은 <strong>지각 기반 압축 기법</strong>으로 살아 있다. 오디오에서 데시벨을 쓰는 것과 같은 이유다. 사람의 감각이 로그에 가까우니, 저장 포맷도 로그에 가깝게 만들어야 같은 비트 수로 더 많은 계조를 담을 수 있다.
</p>

<div class="callout callout-warn">
<div class="callout-title">그래서 두 번 눌리는 것은 아니다</div>
<p>흔한 오해가 "요즘 모니터는 CRT가 아니니 감마 보정이 이중으로 적용된다"는 것이다. 그렇지 않다. LCD와 OLED는 물리적으로는 2.2제곱 특성이 없지만, 기존 콘텐츠와 호환되기 위해 <strong>일부러 CRT와 같은 EOTF를 흉내내도록 만들어져 있다.</strong> 즉 sRGB 인코딩된 값을 넣으면 CRT와 같은 밝기가 나온다. 감마는 이제 하드웨어의 성질이 아니라 <strong>규격상의 약속</strong>이고, 그 약속이 마침 지각적으로도 좋아서 유지된다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">02 — 곡선</span>
</div>

# sRGB 곡선의 정확한 모양, 그리고 8bit

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
01장에서 감마를 "규격상의 약속"이라고 했다. 그 약속에 이름과 정확한 숫자를 붙인 것이 sRGB다. 1996년 HP와 마이크로소프트가 당시의 CRT 모니터와 PC 환경을 기준으로 만든 표준이고, 이후 IEC 61966-2-1로 국제 표준이 되었다. 오늘날 PNG와 JPEG, 8bit 텍스처, 모니터의 기본 모드는 별다른 표시가 없으면 전부 이 곡선으로 인코딩된 것으로 취급한다. 앞 장에서 "대략 2.2제곱"이라고 뭉뚱그린 곡선의 정확한 모양이 무엇인지, 그리고 그 모양이 8bit 안에서 무엇을 하는지가 이 장의 내용이다. 그 모양은 어림값이 아니라 규격 문서가 수식과 상수로 정해 둔 것이고, 뒤에서 볼 UE 코드(08장, 10장)도 그 상수를 그대로 옮겨 쓴다. 그래서 규격에 적힌 인코딩 함수부터 그대로 놓고 시작한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
규격의 인코딩 함수는 하나의 지수 함수가 아니라 두 부분으로 되어 있다. 아주 어두운 구간은 직선이고, 그 위는 지수 곡선이다.
</p>

<div class="eq-anno-wrap">
<div class="formula-label">sRGB Encoding (linear → 저장값)</div>
<div class="eq-anno">
<span class="term">
<span class="t-formula"><i>V</i></span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5.5 Q 26 2, 52 5 T 97 4" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#b45309;">저장할 값<br>0~1 (×255 하면 8bit)</span>
</span>
<span class="op">=</span>
<span class="term">
<span class="t-formula"><i>L</i> × 12.92</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 4 Q 30 6.5, 55 3.5 T 97 5" fill="none" stroke="#3d63e0" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#3d63e0;">L ≤ 0.0031308<br>직선 구간</span>
</span>
<span class="op">또는</span>
<span class="term">
<span class="t-formula">1.055 · <i>L</i><sup>1/2.4</sup> − 0.055</span>
<svg class="t-line" viewBox="0 0 100 9" preserveAspectRatio="none"><path d="M3 5 Q 28 2.5, 54 5.5 T 97 3.5" fill="none" stroke="#0a8f72" stroke-width="2" stroke-linecap="round"/></svg>
<span class="t-label" style="color:#0a8f72;">그 위<br>지수 구간</span>
</span>
</div>
<div class="formula-note">L은 linear 밝기(0~1). 디코드는 이 함수의 역이다. 지수가 1/2.4인데 전체 곡선의 실효 지수는 약 1/2.2가 되는데, 직선 구간과 1.055 배율이 곡선을 살짝 들어올리기 때문이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
직선 구간이 있는 이유는 두 가지다. 첫째, <code>L<sup>1/2.4</sup></code>는 원점에서 미분값이 무한이라 0 근처에서 다루기 까다롭다. 아래 그림 오른쪽에서 원점 근처를 확대해 붉은 띠로 표시한 구간이 그곳이다. 둘째, 실제 디스플레이는 완전한 검정을 내지 못하므로 그 영역에 정밀도를 몰아줄 이유가 없다. 그래서 아주 어두운 구간만 직선으로 잘라 냈다. 이 직선 구간의 존재가 순수한 <code>pow(x, 2.2)</code>와 정확한 sRGB 곡선을 구별하는 지점이고, UE에도 두 경로가 따로 있다(08장).
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 350" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="sRGB 인코딩 곡선의 전체 모양과 원점 확대. 직선 구간과 지수 구간, 미분값이 발산하는 구간 표시">
<rect x="10" y="10" width="740" height="330" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="34" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">sRGB 인코딩 곡선의 두 부분, 그리고 원점 근처</text>
<text x="60" y="54" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">전체 범위 (L 0 ~ 1)</text>
<g fill="none" stroke="#eef1f5" stroke-width="1">
<path d="M60 179.0 L 330 179.0"/>
<path d="M60 64.0 L 330 64.0"/>
<path d="M195.0 294 L 195.0 64"/>
<path d="M330.0 294 L 330.0 64"/>
</g>
<g fill="none" stroke="#9ca3af" stroke-width="1.2"><path d="M60 64 L 60 294 L 330 294"/></g>
<text x="60.0" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0</text>
<text x="195.0" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0.5</text>
<text x="330.0" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">1</text>
<text x="54" y="298.0" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0</text>
<text x="54" y="183.0" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0.5</text>
<text x="54" y="68.0" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">1</text>
<text x="195" y="328" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">L (linear 밝기)</text>
<text transform="translate(30 179) rotate(-90)" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">V (저장값)</text>
<path d="M60.0 294.0 L60.0 293.5 L60.2 292.1 L60.4 289.8 L60.7 286.6 L61.1 282.6 L61.5 278.6 L62.1 274.8 L62.7 271.0 L63.4 267.4 L64.2 263.8 L65.1 260.2 L66.1 256.7 L67.1 253.3 L68.3 249.9 L69.5 246.5 L70.8 243.2 L72.2 239.9 L73.7 236.6 L75.2 233.4 L76.9 230.2 L78.6 227.0 L80.4 223.9 L82.3 220.8 L84.3 217.7 L86.4 214.6 L88.5 211.5 L90.8 208.5 L93.1 205.5 L95.5 202.5 L98.0 199.5 L100.5 196.5 L103.2 193.6 L105.9 190.6 L108.8 187.7 L111.7 184.8 L114.7 181.9 L117.8 179.0 L120.9 176.2 L124.2 173.3 L127.5 170.5 L130.9 167.6 L134.4 164.8 L138.0 162.0 L141.7 159.2 L145.4 156.4 L149.3 153.6 L153.2 150.9 L157.2 148.1 L161.3 145.4 L165.5 142.6 L169.7 139.9 L174.1 137.2 L178.5 134.5 L183.0 131.8 L187.6 129.1 L192.3 126.4 L197.1 123.7 L201.9 121.0 L206.9 118.4 L211.9 115.7 L217.0 113.1 L222.2 110.4 L227.4 107.8 L232.8 105.2 L238.2 102.6 L243.8 99.9 L249.4 97.3 L255.1 94.7 L260.9 92.1 L266.7 89.6 L272.7 87.0 L278.7 84.4 L284.8 81.8 L291.0 79.3 L297.3 76.7 L303.7 74.2 L310.1 71.6 L316.7 69.1 L323.3 66.5 L330.0 64.0" fill="none" stroke="#0a8f72" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
<text x="232" y="140" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#0a8f72">지수 구간 (L &gt; 0.0031308)</text>
<rect x="58" y="280" width="14" height="16" rx="2" fill="#f87171" fill-opacity="0.18" stroke="#dc2626" stroke-width="1.4"/>
<text x="82" y="262" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#dc2626">직선 구간 (L ≤ 0.0031308)</text>
<text x="82" y="277" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#b91c1c">이 축척에서는 점 하나 크기. 오른쪽에 확대</text>
<text x="430" y="54" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">원점 확대 (L 0 ~ 0.006), 왼쪽 붉은 네모 안</text>
<rect x="430" y="64" width="19.3" height="230" fill="#f87171" fill-opacity="0.18"/>
<g fill="none" stroke="#eef1f5" stroke-width="1">
<path d="M430 64.0 L 720 64.0"/>
<path d="M720 294 L 720 64"/>
</g>
<g fill="none" stroke="#9ca3af" stroke-width="1" stroke-dasharray="3 3"><path d="M430 216.5 L 581.3 216.5 L 581.3 294"/></g>
<g fill="none" stroke="#9ca3af" stroke-width="1.2"><path d="M430 64 L 430 294 L 720 294"/></g>
<text x="430" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0</text>
<text x="581.3" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" font-weight="700" fill="#4b5563">0.0031308</text>
<text x="720" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0.006</text>
<text x="424" y="298" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0</text>
<text x="424" y="220.5" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" font-weight="700" fill="#4b5563">0.04045</text>
<text x="424" y="68" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0.12</text>
<text x="575" y="328" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">L (linear 밝기)</text>
<text transform="translate(372 179) rotate(-90)" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">V (저장값)</text>
<path d="M430.0 294.0 L430.0 292.6 L430.0 290.8 L430.0 288.6 L430.1 286.3 L430.2 283.8 L430.3 281.2 L430.5 278.5 L430.7 275.7 L431.0 272.8 L431.3 269.8 L431.8 266.7 L432.3 263.6 L432.9 260.4 L433.7 257.1 L434.5 253.8 L435.5 250.4 L436.6 247.0 L437.8 243.5 L439.2 240.0 L440.7 236.4 L442.4 232.8 L444.3 229.1 L446.3 225.4 L448.6 221.7 L451.0 217.9 L453.6 214.1 L456.4 210.2 L459.5 206.3 L462.7 202.4 L466.2 198.4 L470.0 194.4 L474.0 190.4 L478.2 186.3 L482.8 182.2 L487.6 178.1 L492.6 173.9 L498.0 169.7 L503.7 165.5 L509.6 161.3 L515.9 157.0 L522.5 152.7 L529.5 148.4 L536.7 144.1 L544.4 139.7 L552.3 135.3 L560.7 130.9 L569.4 126.4 L578.5 122.0 L588.0 117.5 L597.8 112.9 L608.1 108.4 L618.8 103.9 L629.9 99.3 L641.4 94.7 L653.4 90.0 L665.8 85.4 L678.6 80.7 L692.0 76.0 L705.7 71.3 L720.0 66.6" fill="none" stroke="#9ca3af" stroke-width="1.8" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round"/>
<text x="712" y="120" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">L<tspan font-size="8" dy="-4">1/2.4</tspan><tspan dy="4"> 그대로 (비교용)</tspan></text>
<path d="M430.0 294.0 L581.3 216.5" fill="none" stroke="#3d63e0" stroke-width="2.6" stroke-linecap="round"/>
<path d="M581.3 216.5 L584.8 214.7 L588.3 213.0 L591.7 211.3 L595.2 209.7 L598.7 208.0 L602.1 206.4 L605.6 204.8 L609.1 203.2 L612.5 201.6 L616.0 200.1 L619.5 198.5 L622.9 197.0 L626.4 195.5 L629.9 194.0 L633.3 192.5 L636.8 191.0 L640.3 189.6 L643.7 188.2 L647.2 186.7 L650.7 185.3 L654.1 183.9 L657.6 182.6 L661.1 181.2 L664.5 179.8 L668.0 178.5 L671.5 177.1 L674.9 175.8 L678.4 174.5 L681.9 173.2 L685.3 171.9 L688.8 170.6 L692.3 169.4 L695.7 168.1 L699.2 166.8 L702.7 165.6 L706.1 164.4 L709.6 163.1 L713.1 161.9 L716.5 160.7 L720.0 159.5" fill="none" stroke="#0a8f72" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<text x="480" y="282" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#3d63e0">직선 구간, 기울기 12.92 고정</text>
<text x="712" y="205" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#0a8f72">sRGB 곡선 구간</text>
<circle cx="581.3" cy="216.5" r="4.2" fill="#ffffff" stroke="#4b5563" stroke-width="2"/>
<text x="602" y="238" font-family="Segoe UI, sans-serif" font-size="10.5" font-weight="700" fill="#4b5563">이음새 (8bit 저장값 ≈ 10)</text>
<text x="602" y="253" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">곡선의 접선 기울기 12.70</text>
<text x="602" y="268" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">직선 12.92와 거의 같다</text>
<text x="456" y="84" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#dc2626">미분값 → ∞</text>
<text x="456" y="99" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#b91c1c">0 근처에서 기울기가 한없이 커진다</text>
</svg>
<div class="scene-cap">왼쪽은 sRGB 인코딩 함수 전체다. 이 축척에서는 매끈한 곡선 하나로 보이고, 직선 구간은 원점의 붉은 네모 안에 점 하나 크기로 들어가 있다. 오른쪽은 그 네모를 확대한 것이다. 회색 점선은 비교용으로 그린 <code>L<sup>1/2.4</sup></code>인데, 원점에서 거의 수직으로 출발한다. 기울기가 한없이 커지는 이 구간(붉은 띠)을 sRGB는 기울기 12.92의 직선으로 대체했다. 이음새 L = 0.0031308에서 직선의 값 12.92 × 0.0031308 = 0.04045가 곡선 구간의 값과 일치하고, 곡선의 접선 기울기 12.70도 직선의 12.92와 거의 같아서 두 부분이 매끄럽게 이어진다. 8bit 저장값으로 보면 직선 구간은 0~10, 256칸 중 11칸이다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
위 그림의 세로축 0~1은 8bit로 저장하면 0~255가 된다. 같은 곡선을 저장값 단위로 다시 그리면 다음과 같다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 350" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="sRGB 곡선을 8bit 저장값 0~255 축으로 그린 그림. 저장값 128은 linear 0.216, linear 0.5는 저장값 188">
<rect x="10" y="10" width="740" height="330" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="34" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">같은 곡선을 8bit 저장값으로 읽으면</text>
<text x="80" y="54" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">세로축 = 앞 그림의 V × 255</text>
<g fill="none" stroke="#eef1f5" stroke-width="1"><path d="M80 64 L 400 64"/><path d="M400 294 L 400 64"/></g>
<path d="M80 294 L 400 64" fill="none" stroke="#9ca3af" stroke-width="1.4" stroke-dasharray="2 4"/>
<g fill="none" stroke="#b45309" stroke-width="1.2" stroke-dasharray="4 3"><path d="M80 178.5 L 149.1 178.5 L 149.1 294"/></g>
<path d="M149.1 178.5 L 240.0 178.5" fill="none" stroke="#c7cdd8" stroke-width="1" stroke-dasharray="2 3"/>
<g fill="none" stroke="#3d63e0" stroke-width="1.2" stroke-dasharray="4 3"><path d="M80 124.9 L 240.0 124.9 L 240.0 294"/></g>
<g fill="none" stroke="#9ca3af" stroke-width="1.2"><path d="M80 64 L 80 294 L 400 294"/></g>
<text x="80" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0</text>
<text x="149.1" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" font-weight="700" fill="#b45309">0.216</text>
<text x="240.0" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" font-weight="700" fill="#3d63e0">0.5</text>
<text x="400" y="310" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">1.0</text>
<text x="240" y="328" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">L (linear 밝기, 1.0 = 흰색)</text>
<text x="74" y="298" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0</text>
<text x="74" y="182.5" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" font-weight="700" fill="#b45309">128</text>
<text x="74" y="128.9" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" font-weight="700" fill="#3d63e0">188</text>
<text x="74" y="68" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">255</text>
<text transform="translate(36 179) rotate(-90)" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">저장값 (8bit)</text>
<path d="M80.0 294.0 L80.0 293.5 L80.2 292.1 L80.5 289.8 L80.8 286.6 L81.2 282.6 L81.8 278.6 L82.5 274.8 L83.2 271.0 L84.0 267.4 L85.0 263.8 L86.0 260.2 L87.2 256.7 L88.5 253.3 L89.8 249.9 L91.2 246.5 L92.8 243.2 L94.5 239.9 L96.2 236.6 L98.0 233.4 L100.0 230.2 L102.0 227.0 L104.2 223.9 L106.4 220.8 L108.8 217.7 L111.2 214.6 L113.8 211.5 L116.5 208.5 L119.2 205.5 L122.0 202.5 L125.0 199.5 L128.1 196.5 L131.2 193.6 L134.4 190.6 L137.8 187.7 L141.2 184.8 L144.8 181.9 L148.4 179.0 L152.2 176.2 L156.1 173.3 L160.0 170.5 L164.1 167.6 L168.2 164.8 L172.4 162.0 L176.8 159.2 L181.2 156.4 L185.8 153.6 L190.5 150.9 L195.2 148.1 L200.1 145.4 L205.0 142.6 L210.0 139.9 L215.2 137.2 L220.4 134.5 L225.8 131.8 L231.2 129.1 L236.8 126.4 L242.5 123.7 L248.2 121.0 L254.1 118.4 L260.0 115.7 L266.0 113.1 L272.2 110.4 L278.4 107.8 L284.8 105.2 L291.2 102.6 L297.8 99.9 L304.4 97.3 L311.2 94.7 L318.1 92.1 L325.0 89.6 L332.0 87.0 L339.2 84.4 L346.4 81.8 L353.8 79.3 L361.2 76.7 L368.8 74.2 L376.5 71.6 L384.2 69.1 L392.1 66.5 L400.0 64.0" fill="none" stroke="#0a8f72" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<text x="96" y="140" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#0a8f72">sRGB 인코딩 곡선</text>
<circle cx="240.0" cy="178.5" r="4.2" fill="#ffffff" stroke="#9ca3af" stroke-width="1.8"/>
<circle cx="149.1" cy="178.5" r="4.8" fill="#b45309" stroke="#ffffff" stroke-width="1.8"/>
<circle cx="240.0" cy="124.9" r="4.8" fill="#3d63e0" stroke="#ffffff" stroke-width="1.8"/>
<text x="430" y="84" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#4b5563">이 그림에서 볼 두 점</text>
<circle cx="436" cy="108" r="4.5" fill="#b45309"/>
<text x="448" y="112" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#b45309">저장값 128 → linear 0.216</text>
<text x="448" y="128" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">0~255의 정확한 중간값인데 밝기는 21.6%다</text>
<circle cx="436" cy="154" r="4.5" fill="#3d63e0"/>
<text x="448" y="158" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#3d63e0">linear 0.5 → 저장값 188</text>
<text x="448" y="174" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">흰색 밝기의 절반은 128이 아니라 188에 있다</text>
<circle cx="436" cy="200" r="4.2" fill="#ffffff" stroke="#9ca3af" stroke-width="1.8"/>
<text x="448" y="204" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#6b7280">점선 대각선: 저장값이 밝기에 비례한다는 직관</text>
<text x="448" y="220" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#6b7280">그 위에서는 128이 50%다. 실제 곡선은 그보다 위에 있다</text>
<text x="430" y="256" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#9ca3af">두 점의 차이가 "묘하게 어둡다 / 묘하게 밝다"의 원인이다.</text>
<text x="430" y="272" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#9ca3af">계산은 아래 본문에서 한다.</text>
</svg>
<div class="scene-cap">앞 그림과 같은 곡선이지만 세로축을 8bit 저장값 0~255로 바꿔 그렸다. 회색 점선은 저장값이 밝기에 비례한다고 가정했을 때의 직선이고, 그 위에서는 128이 정확히 50%다. 실제 sRGB 곡선은 이 직선보다 위에 있어서, 저장값 128은 linear 0.216에 걸리고, 흰색 밝기의 절반인 linear 0.5는 저장값 188에 걸린다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
이제 위 그림의 두 점을 숫자로 확인하자. 저장값 128을 디코드하면 linear 값이 얼마인가. <code>((128/255 + 0.055) / 1.055)<sup>2.4</sup> = 0.2159</code> 다. 즉 <strong>0~255의 정확히 중간값인 128은 흰색 밝기의 절반이 아니라 21.6%다.</strong> 반대로 흰색의 절반인 linear 0.5를 저장하려면 128이 아니라 <strong>188</strong>을 써야 한다. 이 두 숫자를 외워 두면 색 관련 버그를 볼 때 절반은 바로 진단이 된다. 화면이 "묘하게 어둡다"면 188이어야 할 값이 128로 들어간 것이고, "묘하게 밝고 뿌옇다"면 그 반대다.
</p>

<p style="color:var(--text2);line-height:1.85;">
sRGB가 8bit에서 벌어 주는 이득도 계산할 수 있다. linear 값을 8bit에 그대로 담으면 저장값이 1 바뀔 때 linear 값은 <code>1/255 = 0.00392</code>씩 바뀌고, 이 간격이 전 구간 일정하다. sRGB로 담으면 가장 어두운 쪽에서는 저장값 1 차이가 linear <code>0.000304</code>이고, 가장 밝은 쪽에서는 <code>0.0089</code>다. 즉 sRGB는 어두운 쪽에서 <strong>linear보다 약 13배 촘촘하고</strong>, 자기 내부에서도 어두운 쪽과 밝은 쪽의 간격이 <strong>약 29배 차이</strong>가 난다. 눈이 민감한 곳에 비트를 몰아주고 둔감한 곳에서 아끼는 것이 정확히 이 배분이다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="linear 8bit와 sRGB 8bit의 계조 배분 비교">
<rect x="10" y="10" width="740" height="230" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">같은 256칸을 어디에 쓰는가</text>

<text x="30" y="72" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#b45309">linear 8bit</text>
<text x="30" y="89" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">칸 크기가 전 구간 동일 (1/255)</text>
<g fill="#b45309">
<rect x="150" y="60" width="1.6" height="26"/><rect x="205" y="60" width="1.6" height="26"/><rect x="260" y="60" width="1.6" height="26"/>
<rect x="315" y="60" width="1.6" height="26"/><rect x="370" y="60" width="1.6" height="26"/><rect x="425" y="60" width="1.6" height="26"/>
<rect x="480" y="60" width="1.6" height="26"/><rect x="535" y="60" width="1.6" height="26"/><rect x="590" y="60" width="1.6" height="26"/>
<rect x="645" y="60" width="1.6" height="26"/><rect x="700" y="60" width="1.6" height="26"/>
</g>
<text x="150" y="106" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#9ca3af">어두운 쪽: 칸이 너무 넓어 밴딩</text>

<text x="30" y="152" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#0a8f72">sRGB 8bit</text>
<text x="30" y="169" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">어두운 쪽에 칸이 몰려 있다</text>
<g fill="#0a8f72">
<rect x="150" y="140" width="1.6" height="26"/><rect x="158" y="140" width="1.6" height="26"/><rect x="169" y="140" width="1.6" height="26"/>
<rect x="184" y="140" width="1.6" height="26"/><rect x="204" y="140" width="1.6" height="26"/><rect x="230" y="140" width="1.6" height="26"/>
<rect x="264" y="140" width="1.6" height="26"/><rect x="308" y="140" width="1.6" height="26"/><rect x="364" y="140" width="1.6" height="26"/>
<rect x="432" y="140" width="1.6" height="26"/><rect x="512" y="140" width="1.6" height="26"/><rect x="604" y="140" width="1.6" height="26"/>
<rect x="700" y="140" width="1.6" height="26"/>
</g>
<text x="150" y="186" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#9ca3af">눈이 민감한 어두운 쪽에 정밀도 집중</text>

<g stroke="#d5dbe6" stroke-width="1"><path d="M150 205 L 700 205"/></g>
<text x="150" y="224" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">linear 0.0</text>
<text x="410" y="224" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">0.5 (= 저장값 188)</text>
<text x="672" y="224" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">1.0</text>
<g stroke="#f87171" stroke-width="1.2" stroke-dasharray="3 3"><path d="M432 130 L 432 210"/></g>
</svg>
<div class="scene-cap">가로축은 linear 밝기다. 세로 막대는 8bit 저장값이 표현할 수 있는 지점들이고, 보기 좋게 일부만 그렸다. linear 8bit는 칸을 균등하게 배분해서 어두운 영역에 계조가 부족하고(밴딩), sRGB 8bit는 어두운 쪽으로 칸을 몰아 눈이 민감한 곳의 정밀도를 확보한다. 저장값 188이 linear 0.5에 해당하는 지점이 붉은 선이다.</div>
</div>

<div class="callout callout-teal">
<div class="callout-title">그러면 float에는 왜 안 쓰는가</div>
<p>인코딩은 <strong>비트가 부족할 때만</strong> 필요하다. FP16은 지수부가 따로 있어서 값이 작아지면 자동으로 정밀도가 올라간다. 즉 부동소수점 자체가 이미 비율 기반 표현이라, 위와 같은 곡선을 덧씌울 이유가 없다. 그래서 UE의 픽셀 포맷 중 float 계열에는 sRGB 플래그를 붙일 수 없고(09장), 텍스처 빌드 파이프라인도 16bit·32bit 이미지는 언제나 linear로 취급한다(07장).</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">03 — 핵심</span>
</div>

# 왜 계산은 linear에서만 옳은가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
여기가 이 글의 핵심 장이다. 앞의 두 장은 "저장은 sRGB로 하면 이득이다"는 이야기였고, 이 장은 "계산은 절대 sRGB에서 하면 안 된다"는 이야기다. 이유는 한 문장으로 끝난다. <strong>빛은 더해지지만 sRGB 값은 더해지지 않는다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
전구 두 개를 켜면 방의 밝기는 각각의 밝기를 더한 값이다. 이것은 광자를 세는 문제라서 예외가 없다. 그런데 sRGB 값은 밝기에 비례하지 않으므로, sRGB 값끼리 더하면 그 결과는 아무 물리적 의미가 없다. 렌더링에서 값을 더하거나 곱하거나 평균내는 연산은 전부 광자를 세는 연산이고, 그래서 전부 linear에서 해야 한다. 구체적으로는 크게 네 가지 카테고리에서 문제가 된다.
</p>

<div class="flow-row">
<div class="flow-step hot"><div class="step-num">1</div><div class="step-name">조명 합산</div><div class="step-desc">여러 광원의 기여를 더하는 연산. sRGB에서 더하면 두 광원이 겹친 곳이 실제보다 지나치게 밝아지고 쉽게 흰색으로 날아간다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step hot"><div class="step-num">2</div><div class="step-name">알파 블렌딩</div><div class="step-desc">반투명 합성은 두 밝기의 가중 평균. sRGB에서 섞으면 경계가 어둡게 죽는다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step hot"><div class="step-num">3</div><div class="step-name">텍스처 필터링</div><div class="step-desc">bilinear 보간도 가중 평균이다. 하드웨어 샘플러가 디코드 후에 보간해야 옳다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step hot"><div class="step-num">4</div><div class="step-name">밉맵 생성</div><div class="step-desc">네 텍셀의 평균. 여기서 틀리면 멀리 있는 물체가 통째로 어두워진다</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
가장 극적인 예는 4번이다. 검정과 흰색이 번갈아 있는 체커보드 텍스처의 밉맵을 만든다고 하자. 물리적으로 옳은 답은 명확하다. 절반은 빛을 전부 반사하고 절반은 전혀 반사하지 않으니, 멀리서 보면 흰색의 절반 밝기, 즉 <strong>linear 0.5</strong>가 되어야 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그런데 저장된 8bit 값을 그대로 평균내면 <code>(0 + 255) / 2 = 127.5</code>가 나온다. 이 값을 디코드하면 linear <strong>0.214</strong>다. 정답인 0.5와 비교하면 <strong>2.34배 어둡다.</strong> 옳게 하려면 먼저 두 값을 디코드해서 0과 1로 만들고, 평균 0.5를 구한 뒤 다시 인코딩해서 <strong>188</strong>을 저장해야 한다. 127.5와 188의 차이, 이것을 이해하는 것이 가장 중요하다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="체커보드 밉맵을 sRGB 값에서 평균낸 결과와 linear에서 평균낸 결과의 비교">
<rect x="10" y="10" width="740" height="280" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#4b5563">흑백 체커보드의 밉맵 한 단계</text>

<!-- source checker -->
<g>
<rect x="40" y="60" width="120" height="120" fill="#ffffff" stroke="#9ca3af"/>
<rect x="40" y="60" width="30" height="30" fill="#000000"/><rect x="100" y="60" width="30" height="30" fill="#000000"/>
<rect x="70" y="90" width="30" height="30" fill="#000000"/><rect x="130" y="90" width="30" height="30" fill="#000000"/>
<rect x="40" y="120" width="30" height="30" fill="#000000"/><rect x="100" y="120" width="30" height="30" fill="#000000"/>
<rect x="70" y="150" width="30" height="30" fill="#000000"/><rect x="130" y="150" width="30" height="30" fill="#000000"/>
<text x="40" y="200" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#4b5563">원본: 저장값 0과 255</text>
<text x="40" y="217" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#6b7280">linear로는 0.0과 1.0</text>
</g>

<!-- arrows -->
<g stroke="#9ca3af" stroke-width="1.6" fill="none">
<path d="M180 100 L 225 100"/><path d="M217 95 L 226 100 L 217 105"/>
<path d="M180 150 L 225 150"/><path d="M217 145 L 226 150 L 217 155"/>
</g>

<!-- wrong path -->
<g>
<rect x="240" y="62" width="200" height="76" rx="7" fill="#fef2f2" stroke="#fca5a5"/>
<text x="252" y="82" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#b91c1c">틀린 방법: 저장값을 그대로 평균</text>
<text x="252" y="101" font-family="Consolas, monospace" font-size="11.5" fill="#7f1d1d">(0 + 255) / 2 = 127.5</text>
<text x="252" y="119" font-family="Consolas, monospace" font-size="11.5" fill="#7f1d1d">디코드 → linear 0.214</text>
<text x="252" y="133" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#b91c1c">정답보다 2.34배 어둡다</text>
</g>

<!-- right path -->
<g>
<rect x="240" y="150" width="200" height="90" rx="7" fill="#f0fdf9" stroke="#5eead4"/>
<text x="252" y="170" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#0f766e">옳은 방법: 디코드하고 평균</text>
<text x="252" y="189" font-family="Consolas, monospace" font-size="11.5" fill="#115e59">디코드 → 0.0, 1.0</text>
<text x="252" y="206" font-family="Consolas, monospace" font-size="11.5" fill="#115e59">평균 → linear 0.5</text>
<text x="252" y="223" font-family="Consolas, monospace" font-size="11.5" fill="#115e59">인코딩 → 저장값 188</text>
<text x="252" y="236" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#0f766e">물리적으로 옳은 밝기</text>
</g>

<!-- results -->
<g>
<rect x="470" y="62" width="110" height="76" fill="#797979" stroke="#9ca3af"/>
<text x="470" y="155" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#b91c1c" font-weight="700">저장값 128</text>
<rect x="600" y="62" width="110" height="76" fill="#bcbcbc" stroke="#9ca3af"/>
<text x="600" y="155" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#0f766e" font-weight="700">저장값 188</text>
</g>
<text x="470" y="192" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">위 두 사각형은 실제 sRGB 값으로 칠했다.</text>
<text x="470" y="209" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">왼쪽이 체커보드가 멀어질 때 어두워지는</text>
<text x="470" y="226" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b7280">현상의 원인이다.</text>
</svg>
<div class="scene-cap">밉맵은 텍셀 평균이므로 반드시 linear에서 계산해야 한다. sRGB 값을 그대로 평균내면 결과가 2.34배 어두워지고, 밉 레벨이 내려갈수록 누적되어 멀리 있는 물체가 통째로 어두워진다. 하드웨어 sRGB 텍스처에서 이 문제가 발생하지 않는 이유는 샘플러가 필터링 전에 디코드하기 때문이고, 오프라인 밉 생성도 같은 순서를 따른다(07장).</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
1번 조명 합산도 같은 계산이다. 저장값 128인 회색 면에 두 광원이 각각 그 밝기만큼 기여한다고 하자. 옳은 답은 linear 0.2159를 두 번 더한 0.4317이고, 저장값으로는 <strong>176</strong>이다. sRGB 값을 그대로 더하면 <code>128 + 128 = 256</code>이 되어 <strong>255로 잘린다.</strong> 흰색으로 완전히 날아가는 것이다. 두 광원이 겹친 곳이 유독 하얗게 타는 화면은 이 실수의 전형적인 모습이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
반대 방향으로 보면 "밝기를 2배로 올린다"는 조작이 sRGB 값에서는 아예 표현이 안 된다는 것도 알 수 있다. linear에서는 무조건 2를 곱하면 되지만, sRGB 저장값에서는 원래 값에 따라 곱해야 하는 수가 계속 달라진다.
</p>

<div class="data-table">
<table>
<tr><th>원래 저장값</th><th>linear 값</th><th>2배한 linear</th><th>2배 후 저장값</th><th>저장값 기준 배율</th></tr>
<tr><td><code>32</code></td><td>0.0144</td><td>0.0289</td><td><code>47</code></td><td>1.47배</td></tr>
<tr><td><code>64</code></td><td>0.0513</td><td>0.1025</td><td><code>90</code></td><td>1.41배</td></tr>
<tr><td><code>128</code></td><td>0.2159</td><td>0.4317</td><td><code>176</code></td><td>1.38배</td></tr>
<tr><td><code>200</code></td><td>0.5776</td><td>1.1552</td><td><code>255</code>(포화)</td><td>표현 불가</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
"빛을 2배로"라는 하나의 물리적 조작이 저장값 기준으로는 1.47배, 1.41배, 1.38배로 계속 달라지고, 밝은 영역에서는 아예 범위를 벗어난다. 노출(exposure)이 곧 밝기 배수이므로, 이 표는 <strong>sRGB 공간에서는 노출 조정을 제대로 할 수 없다</strong>는 말과 같다. 04장에서 볼 HDR 파이프라인이 linear를 전제하는 실질적인 이유가 여기 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
2번 알파 블렌딩은 밉맵과 수학이 동일하다. 검정 배경 위에 흰색을 알파 0.5로 얹으면 결과는 두 밝기의 중간, 즉 linear 0.5이고 저장값 188이다. sRGB 값에서 섞으면 127.5가 나와서 실제보다 어둡다. 흰 글자에 반투명 페이드를 걸었을 때 중간 단계가 지저분하게 어두워지는 현상이 이것이다. 3번 텍스처 필터링도 bilinear 보간이 가중 평균이므로 같은 문제이고, 이쪽은 하드웨어가 알아서 해결해 준다. sRGB 포맷으로 만든 텍스처는 샘플러가 <strong>디코드를 먼저 하고 보간을 나중에</strong> 하도록 규격에 정해져 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
여기까지가 이론상 설명할 수 있는 내용이다. 그러면 실제 코드에서 이 네 가지 카테고리는 어디에서 갈리는가. 답부터 말하면, 조명 합산은 셰이더가 값을 내보내고 하드웨어 블렌더가 더하는 경우이고, <strong>알파 블렌딩·텍스처 필터링·밉맵 생성은 셰이더 코드가 아니라 리소스와 뷰를 만드는 D3D12 API 호출에서 결정된다.</strong> 픽셀 셰이더에 아무 실수가 없어도 <code>DXGI_FORMAT</code>을 하나 잘못 고르면 하드웨어가 인코딩된 값을 그대로 더하고 평균낸다. 그래서 색 버그는 셰이더를 아무리 들여다봐도 안 보이고, 텍스처·렌더타깃·뷰를 만드는 코드에서 발견된다. UE 5.8과 D3D12 기준으로 네 카테고리를 하나씩 보자.
</p>

<div class="data-table">
<table>
<tr><th>카테고리</th><th>연산을 실제로 하는 주체</th><th>갈리는 지점 (D3D12)</th><th>UE 5.8에서 결정하는 코드</th></tr>
<tr><td>조명 합산</td><td>하드웨어 블렌더 (<code>BO_Add, BF_One, BF_One</code>)</td><td>렌더타깃 포맷이 float인가</td><td><code>LightRendering.cpp</code> · <code>SceneTexturesConfig.cpp</code></td></tr>
<tr><td>알파 블렌딩</td><td>하드웨어 블렌더 (<code>BF_SourceAlpha, BF_InverseSourceAlpha</code>)</td><td>RTV 포맷이 <code>_UNORM_SRGB</code>인가 <code>_UNORM</code>인가</td><td><code>D3D12Texture.cpp</code> · <code>D3D12Viewport.cpp</code> · <code>SlateRHIRenderingPolicy.cpp</code></td></tr>
<tr><td>텍스처 필터링</td><td>샘플러</td><td>SRV 포맷이 <code>_UNORM_SRGB</code>인가</td><td><code>RHIResources.cpp</code> → <code>DXGIUtilities.h</code></td></tr>
<tr><td>밉맵 생성</td><td>컴퓨트 셰이더 (SRV 읽기 + UAV 쓰기)</td><td>UAV에는 <code>_SRGB</code> 포맷이 없다. 쓰기 인코딩은 수동</td><td><code>GenerateMips.cpp</code> · <code>DXGIUtilities.h</code></td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>1번 조명 합산.</strong> 디퍼드 라이팅에서 라이트 하나의 기여를 scene color에 더하는 것은 픽셀 셰이더가 아니라 하드웨어 블렌더다. 라이트를 그릴 때의 PSO 블렌드 상태와 렌더타깃 바인딩을 보면 알 수 있다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Renderer/Private/LightRendering.cpp (UE 5.8)</span><span class="cm">// SetupLightGraphicsPSOState: 표준 디퍼드 라이트 한 개를 그릴 때의 블렌드 상태. src × 1 + dst × 1</span>
GraphicsPSOInit.BlendState = TStaticBlendState&lt;CW_RGBA, <span class="hl">BO_Add, BF_One, BF_One</span>, BO_Add, BF_One, BF_One&gt;::<span class="fn">GetRHI</span>();

<span class="cm">// GetDeferredLightPSParameters: 대상은 scene color이고 ELoad, 즉 기존 값 위에 누적한다</span>
Out.RenderTargets[<span class="num">0</span>] = <span class="fn">FRenderTargetBinding</span>(SceneColorTexture, ERenderTargetLoadAction::ELoad);</div>

<p style="color:var(--text2);line-height:1.85;">
라이트 하나를 그릴 때마다 <code>scene color = scene color × 1 + 라이트 기여 × 1</code>이 된다. 이 더하기가 올바른 이유는 셰이더 코드가 아니라 대상 포맷에 있다. scene color는 기본값이 <code>PF_FloatRGBA</code>(FP16)이고 데스크톱 Deferred 경로에서는 <code>TexCreate_SRGB</code>가 붙지 않는다(09장). float 포맷에는 인코딩 곡선이 없으므로 블렌더가 더하는 값이 곧 빛의 양이다. 똑같은 블렌드 상태를 <code>PF_B8G8R8A8</code> UNORM 타깃에 걸고 셰이더가 인코딩된 값을 내보내면, 앞에서 본 <code>128 + 128 = 255</code>가 하드웨어 안에서 그대로 일어난다. 직접 만든 패스에서 8bit 렌더타깃에 라이팅이나 이미시브를 누적할 때 나오는 실수가 이것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>2번 알파 블렌딩.</strong> D3D12의 고정 기능 블렌더는 RTV 포맷을 보고 동작한다. RTV가 <code>_UNORM_SRGB</code>이면 블렌더가 대상 픽셀을 디코드해서 linear로 섞은 뒤 다시 인코딩해 쓴다. RTV가 <code>_UNORM</code>이면 저장된 바이트를 그대로 섞는다. 셰이더는 두 경우에 똑같은 값을 내보내므로 셰이더만 보면 차이를 알 수 없다. UE의 D3D12 RHI는 RTV 포맷과 PSO의 렌더타깃 포맷을 둘 다 <code>TexCreate_SRGB</code>를 보고 고른다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/D3D12RHI/Private/D3D12Texture.cpp · D3D12PipelineState.cpp (UE 5.8)</span><span class="cm">// FD3D12Texture::CreateViews: RTV 포맷을 SRV와 같은 함수로, sRGB 플래그를 보고 고른다</span>
<span class="kw">const</span> <span class="kw">bool</span> bSRGB = <span class="fn">EnumHasAnyFlags</span>(Desc.Flags, TexCreate_SRGB);
<span class="kw">const</span> DXGI_FORMAT PlatformRenderTargetFormat = UE::DXGIUtilities::<span class="fn">FindShaderResourceFormat</span>(PlatformResourceFormat, <span class="hl">bSRGB</span>);
...
RTVDesc.Format = PlatformRenderTargetFormat;

<span class="cm">// D3D12PipelineState.cpp: PSO의 렌더타깃 포맷도 같은 규칙. 블렌더는 이 포맷으로 동작한다</span>
RTFormatArray.RTFormats[RTIdx] = UE::DXGIUtilities::<span class="fn">FindShaderResourceFormat</span>(
	UE::DXGIUtilities::<span class="fn">GetPlatformTextureResourceFormat</span>(PlatformFormat, Flags),
	<span class="fn">EnumHasAnyFlags</span>(Flags, ETextureCreateFlags::SRGB));</div>

<p style="color:var(--text2);line-height:1.85;">
즉 <code>TexCreate_SRGB</code>를 붙여 만든 8bit 렌더타깃에서는 반투명 합성이 하드웨어에 의해 linear에서 일어난다. 문제는 그 플래그가 없는 8bit 타깃이고, 대표적인 것이 백버퍼다. 스왑체인 포맷을 고르는 함수에는 sRGB 분기가 없고, 백버퍼 텍스처의 생성 플래그에도 SRGB가 없으며, RTV 포맷은 스왑체인 포맷을 그대로 쓴다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/RHICore/Internal/DXGIUtilities.h · Runtime/D3D12RHI/Private/D3D12Viewport.cpp (UE 5.8)</span><span class="cm">// GetSwapChainFormat: bSRGB 인자가 없다. 스왑체인은 언제나 _UNORM이다</span>
<span class="kw">case</span> DXGI_FORMAT_B8G8R8A8_TYPELESS:  <span class="kw">return</span> <span class="hl">DXGI_FORMAT_B8G8R8A8_UNORM</span>;

<span class="cm">// D3D12Viewport.cpp: 백버퍼 텍스처 플래그. RenderTargetable | Presentable | ResolveTargetable, SRGB 없음</span>
ETextureCreateFlags SwapchainTextureCreateFlags = ETextureCreateFlags::RenderTargetable | ETextureCreateFlags::Presentable | ETextureCreateFlags::ResolveTargetable;

<span class="cm">// 백버퍼 RTV 포맷은 스왑체인 리소스의 포맷 그대로. FindShaderResourceFormat을 거치지 않는다</span>
RTVDesc.Format = BackBufferDesc.Format;</div>

<p style="color:var(--text2);line-height:1.85;">
이 백버퍼 위에 Slate가 UI를 그린다. Slate 픽셀 셰이더는 마지막 줄에서 <code>GammaCorrect</code>로 색을 인코딩해 내보내고(12장), 일반 요소의 블렌드 상태는 <code>BF_SourceAlpha, BF_InverseSourceAlpha</code>다.
</p>

<div class="code-block"><span class="code-lang">C++ · HLSL — SlateRHIRenderingPolicy.cpp · SlateElementPixelShader.usf (UE 5.8)</span><span class="cm">// 일반 Slate 요소의 블렌드 상태 (NoBlending, PreMultipliedAlpha 플래그가 없을 때)</span>
BlendState = TStaticBlendState&lt;CW_RGBA, BO_Add, <span class="hl">BF_SourceAlpha, BF_InverseSourceAlpha</span>, BO_Add, BF_One, BF_InverseSourceAlpha&gt;::<span class="fn">GetRHI</span>();

<span class="cm">// 픽셀 셰이더의 마지막 줄. 블렌더에 들어가는 값은 이미 인코딩된 값이다</span>
OutColor.rgb = <span class="fn">GammaCorrect</span>(OutColor.rgb);</div>

<p style="color:var(--text2);line-height:1.85;">
따라서 SDR에서 UI의 반투명은 인코딩된 값끼리 섞인다. 검정 배경 위에 흰색을 알파 0.5로 얹으면 정확히 앞에서 계산한 127.5가 나온다. UE는 이것을 알고 그대로 둔다. Photoshop을 비롯한 UI 디자인 툴이 기본 설정에서 인코딩 공간에서 합성하므로 디자이너가 만든 시안과 같게 보이는 쪽이기도 하다. HDR 출력에서만 UI를 별도 타깃에 그린 뒤 <code>CompositeUIPixelShader.usf</code>가 <code>sRGBToLinear</code>로 되돌려 linear에서 합성한다. 실수가 되는 것은 이 규칙을 모르고 "반투명은 linear에서 섞였을 것"이라고 가정한 코드다. 어떤 렌더타깃에 반투명을 그린다면, 그 타깃의 RTV 포맷이 무엇인지가 셰이더 코드보다 먼저다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>3번 텍스처 필터링.</strong> SRV 포맷에서 갈린다. D3D12는 SRV 포맷이 <code>_UNORM_SRGB</code>일 때만 샘플러가 텍셀을 디코드한 뒤 보간한다. UE는 텍스처 SRV의 뷰 정보에 이 비트를 따로 들고 있고, UAV 뷰 정보에는 그 비트가 없다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/RHI/Public/RHIResources.h · Runtime/RHI/Private/RHIResources.cpp (UE 5.8)</span><span class="cm">// FRHIViewDesc::FTextureSRV::FViewInfo. SRV에만 있는 비트다</span>
<span class="cm">// Indicates if this view should use an sRGB variant of the typed format.</span>
uint8 <span class="hl">bSRGB</span> : <span class="num">1</span>;

<span class="cm">// RHIResources.cpp: 텍스처의 TexCreate_SRGB에서 파생된다. 이 비트가 DXGIUtilities.h에서 _UNORM_SRGB 포맷을 고른다(07장)</span>
Info.bSRGB = bDisableSRGB ? <span class="kw">false</span> : <span class="fn">EnumHasAnyFlags</span>(Desc.Flags, TexCreate_SRGB);</div>

<p style="color:var(--text2);line-height:1.85;">
실수의 전형은 텍스처를 <code>_UNORM</code> 뷰로 만들어 놓고 셰이더에서 샘플 결과에 <code>pow(x, 2.2)</code>를 하는 것이다. 텍셀 한가운데를 찍으면 값이 맞으므로 테스트를 통과하지만, 텍셀 사이에서는 보간이 이미 인코딩된 값에서 끝난 뒤라 어둡게 처진다. 확대한 텍스처의 텍셀 경계와 밉 전환부에 어두운 띠가 생기는 증상이 이것이다.
</p>

<div class="code-block"><span class="code-lang">HLSL — 예시 (엔진 코드 아님)</span><span class="cm">// 틀린 방법: _UNORM 뷰 + 샘플 뒤 수동 디코드. 보간은 인코딩 공간에서 이미 끝났다</span>
<span class="kw">float3</span> c = <span class="fn">pow</span>(Tex.<span class="fn">Sample</span>(S, uv).rgb, <span class="num">2.2</span>);

<span class="cm">// 옳은 방법: 뷰를 _UNORM_SRGB로 만든다. 샘플러가 디코드 → 보간 순서로 처리하고 셰이더는 아무것도 안 한다</span>
<span class="kw">float3</span> c = Tex.<span class="fn">Sample</span>(S, uv).rgb;</div>

<p style="color:var(--text2);line-height:1.85;">
UE의 텍스처 경로에서는 이 실수가 나오지 않는다. <code>UTexture::SRGB</code>가 SRV 포맷까지 그대로 내려가고, 셰이더의 <code>ProcessMaterialColorTextureLookup</code>은 아무 일도 하지 않기 때문이다(07장, 08장). 나오는 곳은 직접 만든 RHI 텍스처나 렌더타깃을 샘플링하는 코드다.
</p>

<p style="color:var(--text2);line-height:1.85;">
<strong>4번 밉맵 생성.</strong> 여기는 API가 아예 없다. D3D11에는 <code>ID3D11DeviceContext::GenerateMips</code>가 있었지만 D3D12에는 없고, UE의 D3D11·D3D12 RHI에도 하드웨어 밉 생성 호출은 한 줄도 없다. 런타임 밉 생성은 컴퓨트 셰이더가 하고, 여기서 sRGB의 비대칭이 드러난다. 읽기(SRV)는 하드웨어가 디코드해 주지만, 쓰기(UAV)에는 <code>_SRGB</code> 포맷이 없다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/RenderCore/Private/GenerateMips.cpp · Runtime/RHICore/Internal/DXGIUtilities.h (UE 5.8)</span><span class="cm">// FGenerateMips: 텍스처 플래그로 sRGB 셰이더 변형을 고른다. float 포맷은 인코딩 대상이 아니므로 제외</span>
<span class="kw">bool</span> bMipsSRGB = <span class="fn">EnumHasAnyFlags</span>(TextureDesc.Flags, TexCreate_SRGB) &amp;&amp; !<span class="fn">IsFloatFormat</span>(TextureDesc.Format);
PermutationVector.<span class="fn">Set</span>&lt;FGenerateMipsCS::FGenMipsSRGB&gt;(bMipsSRGB);

<span class="cm">// 밉 N-1을 SRV로 읽고 밉 N을 UAV로 쓴다. 읽기는 하드웨어 디코드, 쓰기는 아래 함수의 포맷</span>
SRVDesc.MipLevel = (int8)(MipLevel - <span class="num">1</span>);
UAVDesc.MipLevel = (int8)(MipLevel);
PassParameters-&gt;MipInSRV  = GraphBuilder.<span class="fn">CreateSRV</span>(SRVDesc);
PassParameters-&gt;MipOutUAV = GraphBuilder.<span class="fn">CreateUAV</span>(UAVDesc);

<span class="cm">// DXGIUtilities.h: UAV 포맷 결정. FindShaderResourceFormat(InFormat, bSRGB)와 달리 bSRGB 인자 자체가 없다</span>
<span class="kw">inline</span> DXGI_FORMAT <span class="fn">FindUnorderedAccessFormat</span>(DXGI_FORMAT InFormat)
{
	<span class="kw">switch</span> (InFormat)
	{
	<span class="kw">case</span> DXGI_FORMAT_B8G8R8A8_TYPELESS: <span class="kw">return</span> <span class="hl">DXGI_FORMAT_B8G8R8A8_UNORM</span>;
	<span class="kw">case</span> DXGI_FORMAT_R8G8B8A8_TYPELESS: <span class="kw">return</span> <span class="hl">DXGI_FORMAT_R8G8B8A8_UNORM</span>;
	<span class="kw">case</span> DXGI_FORMAT_R32G8X24_TYPELESS: <span class="kw">return</span> DXGI_FORMAT_R32_FLOAT_X8X24_TYPELESS;
	}
	<span class="kw">return</span> InFormat;
}</div>

<p style="color:var(--text2);line-height:1.85;">
그래서 <code>GENMIPS_SRGB</code> 변형의 셰이더는 UAV에 쓰기 직전에 <code>LinearToSrgb</code>를 직접 부른다(셰이더 원문은 07장). 이 한 줄을 빠뜨리면 linear 값이 sRGB 텍스처에 그대로 저장되고, 다음 밉을 만들 때 SRV가 그것을 한 번 더 디코드해서 레벨이 내려갈수록 점점 어두워진다. 체커보드 예제와 같은 증상이 다른 경로로 나오는 것이다. 오프라인 텍스처 빌드는 이 문제를 구조적으로 피한다. <code>GenerateMipChain</code>은 입력이 32bit float이고 linear라는 것을 <code>check()</code>로 강제하고, sRGB는 마지막 8bit 변환에서 한 번만 적용한다(07장).
</p>

<p style="color:var(--text2);line-height:1.85;">
네 카테고리를 다시 보면, 셰이더 연산이 직접 관여하는 것은 조명 합산뿐이고 그것도 "대상이 float"라는 포맷 결정이 옳음을 보장한다. 알파 블렌딩은 RTV 포맷, 텍스처 필터링은 SRV 포맷, 밉맵 생성은 UAV 포맷의 제약이 결과를 정한다. 전부 <code>DXGI_FORMAT</code> 하나, <code>ETextureCreateFlags</code>의 비트 하나에서 갈린다. 색 버그를 셰이더에서 찾다가 못 찾았다면 리소스와 뷰를 만드는 코드로 가야 한다는 뜻이다.
</p>

<div class="callout callout-purple">
<div class="callout-title">정리하면 규칙은 두 줄이다</div>
<p><strong>저장할 때는 인코딩한다.</strong> 8bit밖에 없을 때 눈이 민감한 곳에 비트를 몰아주기 위해서다.<br>
<strong>계산할 때는 디코드한다.</strong> 더하기·곱하기·평균이 물리적 의미를 가지려면 값이 빛의 양에 비례해야 한다.<br>
이 두 줄만 지키면 linear와 sRGB가 섞여서 생기는 버그는 거의 사라진다. 문제는 파이프라인의 어느 지점에서 누가 그 변환을 하고 있는지가 눈에 잘 보이지 않는다는 것이고, 06장부터 그 지점들을 하나씩 확인한다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">04 — HDR</span>
</div>

# HDR 렌더링이 linear를 전제하는 이유

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
03장까지는 0~1 범위 안에서의 이야기였다. HDR 렌더링은 그 상한을 없앤다. 현실의 밝기 차이는 어마어마하다. 달빛이 비치는 밤길과 정오의 태양은 밝기 차이가 수억 배다. 실내 형광등 아래의 흰 종이와 창밖으로 보이는 하늘도 수십 배 차이가 난다. 물리 기반 렌더링은 이 값들을 실제 비율대로 다루려고 하므로, 계산 중간의 색 값은 1을 한참 넘어간다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 렌더러는 조명 계산 결과를 float 포맷 버퍼에 담는다. 이 버퍼를 scene color라고 부르고, UE의 기본값은 채널당 16bit 부동소수점인 <code>PF_FloatRGBA</code>다(09장). 여기서 중요한 것은 <strong>이 버퍼가 float이라는 사실과 linear라는 사실이 별개의 요구가 아니라 하나의 요구</strong>라는 점이다. 이유는 세 가지다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">상한이 없어야 한다</div>
<div class="card-title">인코딩은 0~1을 전제한다</div>
<div class="card-desc">sRGB 인코딩 함수는 정의역이 0~1이다. 태양의 밝기가 1000이라면 인코딩할 방법 자체가 없다. 값의 범위를 열어 두려면 곡선을 걷어내고 linear로 두는 수밖에 없다.</div>
</div>
<div class="card teal">
<div class="card-label">노출은 곱셈이다</div>
<div class="card-title">한 번의 곱으로 끝나야 한다</div>
<div class="card-desc">자동 노출은 화면 전체 밝기를 재서 배수를 하나 정하는 일이다. linear에서는 그 배수를 곱하면 끝이지만, 03장 표에서 본 것처럼 인코딩된 값에서는 배수 자체가 픽셀마다 달라진다.</div>
</div>
<div class="card gold">
<div class="card-label">중간 연산이 전부 합</div>
<div class="card-title">블룸·반투명·SSR</div>
<div class="card-desc">scene color는 최종 그림이 아니라 여러 패스가 더하고 섞는 작업 버퍼다. 03장의 네 가지 문제가 프레임 내내 반복되는 곳이므로 linear가 아니면 전부 틀린다.</div>
</div>
<div class="card purple">
<div class="card-label">FP16이면 충분하다</div>
<div class="card-title">약 30스톱</div>
<div class="card-desc">FP16은 EV 단위로 약 −14에서 +16 범위를 표현한다. 밝기가 2배씩 달라지는 단위를 스톱이라고 부르는데, 30스톱이면 실사 촬영이 다루는 범위를 통째로 덮는다. 그래서 인코딩으로 비트를 아낄 필요가 없다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
마지막 카드의 숫자는 UE 소스에 그대로 적혀 있다. <code>PostProcessEyeAdaptation.cpp</code>의 노출 범위 계산 주석이 <code>// Float16 has [-14;+16] range in EV units</code>라고 쓰고, 이어서 <code>// Additionally need at least 2 stops below and 8 stops above that in order to not clip any lighting response</code>라고 덧붙인다. 즉 FP16의 표현 범위가 라이팅 응답 전체를 담기에 충분한지를 엔진이 실제로 계산해 두고 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그러면 HDR로 계산한 값을 결국 어떻게 화면에 내보내는가. 모니터는 여전히 정해진 범위밖에 못 받으니 마지막에 눌러 줘야 한다. 이 눌러 주는 단계가 톤매핑이고, 톤매핑 직후에 디스플레이용 인코딩이 붙는다. 이 두 단계가 파이프라인의 마지막 경계이며, UE 5.8이 이 둘을 어떻게 3D LUT 하나로 합쳐 두었는지는 10장에서 본다.
</p>

<div class="callout callout-gold">
<div class="callout-title">톤매핑과 감마 인코딩은 다른 일이다</div>
<p>둘 다 마지막에 붙어 있어서 자주 뭉쳐서 이해되는데, 하는 일이 다르다. <strong>톤매핑</strong>은 0에서 수천까지 퍼진 값을 0~1로 접어 넣는 <strong>범위 압축</strong>이고, 어떤 값을 흰색으로 볼지 정하는 예술적 선택이 들어간다. <strong>인코딩</strong>은 그렇게 나온 0~1 값을 8bit에 담기 위한 <strong>정밀도 배분</strong>이고, 규격이 정해져 있어 선택의 여지가 없다. 톤매핑을 껐다고 감마가 사라지지 않고, 감마를 바꿨다고 톤커브가 달라지지 않는다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">05 — 색공간</span>
</div>

# 선형성과 색공간은 서로 별개의 속성이다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
"sRGB"라는 말이 헷갈리는 이유가 있다. 이 이름이 두 가지 다른 것을 동시에 가리키기 때문이다. 하나는 지금까지 이야기한 전달 함수, 즉 값을 어떻게 눌러 담을지의 곡선이다. 다른 하나는 <strong>색공간(color space)</strong>, 즉 빨강·초록·파랑이라고 부르는 세 원색이 물리적으로 정확히 어떤 색인지의 정의다. 이 둘은 완전히 독립적인 속성이고, 섞어 생각하면 반드시 막힌다.
</p>

<p style="color:var(--text2);line-height:1.85;">
색공간 쪽을 좀 더 쉬운 문장으로 풀면 이렇다. 모니터 두 대에 똑같이 <code>float3(1, 0, 0)</code>을 보내 보자. 값은 같은데, 값싼 모니터의 빨강과 색 표현 범위가 넓은 모니터의 빨강은 눈으로 봐도 다르다. 숫자는 "빨강을 최대로 켜라"는 명령일 뿐이고, <strong>최대로 켰을 때 실제로 어떤 빨강이 나오는지는 이 숫자만으로는 알 수 없다.</strong> 물감으로 비유하면 RGB 값은 세 튜브에서 짜내는 양이고, 색공간은 그 튜브 안에 어떤 빨강·초록·파랑 물감이 들어 있는지다. 같은 양을 짜내도 튜브 안의 물감이 다르면 다른 색이 나온다. 튜브 안의 물감이 정확히 어떤 색인지를 좌표로 적어 둔 것이 primaries<span class="fn-note"><input type="checkbox" id="fn-chroma" class="fn-toggle"><label for="fn-chroma" class="fn-ref">5</label><span class="fn-body"><strong>primaries / chromaticity(원색 좌표):</strong> R, G, B 각각이 정확히 어떤 색인지를 사람의 색 지각 좌표계(CIE xy) 위의 점으로 지정한 것. 여기에 흰색의 기준점(white point)까지 정하면 색공간 하나가 결정된다. sRGB의 빨강은 (0.64, 0.33), Rec.2020의 빨강은 (0.708, 0.292)로 더 순수한 빨강이다.</span></span> 이고, 여기에 "세 물감을 다 섞었을 때 나와야 하는 흰색"의 기준점을 더하면 색공간 하나가 정의된다. 앞 장까지 다룬 전달 함수는 "짜낸 양을 어떤 눈금으로 기록하는가"의 문제이고, 색공간은 "튜브 안에 무엇이 들었는가"의 문제다. 그래서 둘은 서로 무관하게 바꿀 수 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 둘이 별개라는 사실을 가장 잘 보여주는 예가 sRGB와 Rec.709다. <strong>둘의 primaries는 완전히 같고 전달 함수만 다르다.</strong> 그래서 UE의 프로젝트 설정에서도 색공간 선택 항목의 이름이 아예 "sRGB / Rec709"로 붙어 있다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Classes/Engine/RendererSettings.h (UE 5.8)</span><span class="cm">// 색공간 목록에서 sRGB와 Rec709가 한 항목을 공유한다. primaries가 같기 때문이다</span>
<span class="kw">UENUM</span>() <span class="kw">namespace</span> EWorkingColorSpace
{
	sRGB = <span class="num">1</span>  <span class="fn">UMETA</span>(DisplayName = <span class="str">"sRGB / Rec709"</span>,
	          ToolTip = <span class="str">"sRGB / Rec709 (BT.709) color primaries, with D65 white point."</span>),
	Rec2020 = <span class="num">2</span>,
	ACESAP0 = <span class="num">3</span>,
	ACESAP1 = <span class="num">4</span>  <span class="fn">UMETA</span>(DisplayName = <span class="str">"ACES AP1 / ACEScg"</span>),
	...
}</div>

<p style="color:var(--text2);line-height:1.85;">
반대로 P3DCI와 P3D65는 primaries가 같고 흰색 기준점만 다르다. 이 경우에는 흰색이 달라진 만큼을 보정해야 하는데, 그 보정을 chromatic adaptation이라고 부르고 UE는 Bradford 방식을 기본으로 쓴다. 즉 색공간 사이의 변환은 3x3 행렬 곱이고, 흰색 기준점이 다르면 그 중간에 적응 행렬이 하나 더 끼는 구조다.
</p>

<p style="color:var(--text2);line-height:1.85;">
여기서 선형성과 색공간의 관계에 대한 중요한 규칙이 하나 나온다. <strong>색공간 변환은 linear 상태에서만 유효하다.</strong> 행렬 곱은 채널을 섞는 선형 연산이고, 03장의 논리가 그대로 적용된다. UE는 이 규칙을 주석이 아니라 assert로 박아 두었다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/ImageCore/Private/ImageCore.cpp (UE 5.8)</span><span class="cm">// 색공간 변환 함수의 첫 줄이 "이미지가 linear 상태인지" 를 검사한다</span>
<span class="kw">void</span> FImageCore::<span class="fn">TransformToWorkingColorSpace</span>(FImage&amp; InLinearImage, ...)
{
	<span class="fn">check</span>(InLinearImage.GammaSpace == EGammaSpace::Linear);
	...
	<span class="ty">FColorSpaceTransform</span> Transform(Source, FColorSpace::<span class="fn">GetWorking</span>(), Method);
}</div>

<p style="color:var(--text2);line-height:1.85;">
텍스처 빌드 파이프라인의 함수 이름도 이 순서를 그대로 말한다. <code>LinearizeToWorkingColorSpace</code>다. 먼저 선형화하고, 그다음 색공간을 옮긴다. 두 단계이고 순서가 정해져 있다. 실무에서 색공간까지 신경 써야 하는 경우는 많지 않다. 프로젝트가 기본값인 sRGB 색공간을 쓰면 UE는 관련 연산 전부를 no-op으로 건너뛰도록 설계되어 있다(11장). 다만 영상 소재를 들여올 때나 HDR 디스플레이로 출력할 때는 색공간 차이가 실제로 드러나므로, "선형성과 색공간은 다른 문제"라는 구분만 확실히 해 두면 된다.
</p>

<div class="callout callout-info">
<div class="callout-title">그러면 색 하나를 완전히 지정하려면</div>
<p>세 가지가 필요하다. <strong>숫자 세 개</strong>(RGB 값), <strong>전달 함수</strong>(그 숫자가 linear인지 인코딩된 것인지), <strong>색공간</strong>(R·G·B가 어떤 색인지). 셋 중 하나라도 빠지면 그 색은 정해지지 않는다. 코드에서 색을 주고받을 때 버그가 생기는 이유는 보통 숫자만 전달하고 나머지 둘을 암묵적 관례로 남겨 두기 때문이고, UE가 <code>FColor</code>와 <code>FLinearColor</code>를 별개 타입으로 나눠 둔 것은 세 가지 중 두 번째를 타입으로 표현하려는 시도다(08장).</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">06 — 전체 흐름</span>
</div>

# 한 프레임의 렌더링 패스는 어디서 linear이고 어디서 sRGB인가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
이론은 끝났다. 이제 언리얼엔진에서 이 규칙들이 실제로 어디에 구현되어 있는지를 보기 전에, 전체 흐름을 한 장에 펼쳐 두자. 이 그림이 07장부터 12장까지의 목차 역할을 한다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 760 430" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="언리얼엔진에서 색이 거치는 공간 변환의 전체 흐름">
<rect x="10" y="10" width="740" height="410" rx="10" fill="#ffffff" stroke="#d5dbe6"/>

<!-- band labels -->
<rect x="24" y="28" width="712" height="86" rx="8" fill="#fef9ee" stroke="#f0d9a8"/>
<text x="38" y="48" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#8a6116">인코딩된 공간 (저장·표시용, 0~1)</text>

<rect x="24" y="126" width="712" height="190" rx="8" fill="#f0fbf8" stroke="#a7ded1"/>
<text x="38" y="146" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#0f766e">linear 공간 (계산용, 범위 제한 없음)</text>

<rect x="24" y="328" width="712" height="80" rx="8" fill="#fef9ee" stroke="#f0d9a8"/>
<text x="38" y="348" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#8a6116">인코딩된 공간 (디스플레이용)</text>

<!-- top: texture -->
<rect x="46" y="58" width="150" height="42" rx="6" fill="#ffffff" stroke="#c9a95f"/>
<text x="121" y="76" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#4b5563" text-anchor="middle">텍스처 (8bit, sRGB)</text>
<text x="121" y="92" font-family="Consolas, monospace" font-size="10" fill="#8a8f9c" text-anchor="middle">UTexture::SRGB = true</text>

<rect x="222" y="58" width="150" height="42" rx="6" fill="#ffffff" stroke="#c9a95f"/>
<text x="297" y="76" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#4b5563" text-anchor="middle">FColor · vertex color</text>
<text x="297" y="92" font-family="Consolas, monospace" font-size="10" fill="#8a8f9c" text-anchor="middle">8bit 패킹된 색</text>

<rect x="398" y="58" width="150" height="42" rx="6" fill="#ffffff" stroke="#c9a95f"/>
<text x="473" y="76" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#4b5563" text-anchor="middle">GBufferC (BaseColor)</text>
<text x="473" y="92" font-family="Consolas, monospace" font-size="10" fill="#8a8f9c" text-anchor="middle">8bit + TexCreate_SRGB</text>

<rect x="574" y="58" width="140" height="42" rx="6" fill="#ffffff" stroke="#c9a95f"/>
<text x="644" y="76" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#4b5563" text-anchor="middle">Slate 버텍스 컬러</text>
<text x="644" y="92" font-family="Consolas, monospace" font-size="10" fill="#8a8f9c" text-anchor="middle">ToFColor(true)로 패킹</text>

<!-- down arrows with labels -->
<g stroke="#0f766e" stroke-width="1.8" fill="none">
<path d="M121 104 L 121 160"/><path d="M116 153 L 121 161 L 126 153"/>
<path d="M297 104 L 297 160"/><path d="M292 153 L 297 161 L 302 153"/>
<path d="M473 104 L 473 160"/><path d="M468 153 L 473 161 L 478 153"/>
<path d="M644 104 L 644 160"/><path d="M639 153 L 644 161 L 649 153"/>
</g>
<text x="128" y="126" font-family="Segoe UI, sans-serif" font-size="10" fill="#0f766e">하드웨어 샘플러</text>
<text x="128" y="139" font-family="Segoe UI, sans-serif" font-size="10" fill="#0f766e">07장</text>
<text x="304" y="126" font-family="Segoe UI, sans-serif" font-size="10" fill="#0f766e">FLinearColor 생성자</text>
<text x="304" y="139" font-family="Segoe UI, sans-serif" font-size="10" fill="#0f766e">08장</text>
<text x="480" y="126" font-family="Segoe UI, sans-serif" font-size="10" fill="#0f766e">하드웨어 sRGB RT</text>
<text x="480" y="139" font-family="Segoe UI, sans-serif" font-size="10" fill="#0f766e">09장</text>
<text x="651" y="126" font-family="Segoe UI, sans-serif" font-size="10" fill="#0f766e">셰이더가 인코딩</text>
<text x="651" y="139" font-family="Segoe UI, sans-serif" font-size="10" fill="#0f766e">12장</text>

<!-- middle: shading -->
<rect x="46" y="168" width="326" height="56" rx="6" fill="#ffffff" stroke="#5eb39c"/>
<text x="209" y="190" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#0f766e" text-anchor="middle">BRDF · 조명 합산 · 반투명 블렌딩</text>
<text x="209" y="209" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#4b5563" text-anchor="middle">더하기·곱하기·평균이 물리적 의미를 갖는 유일한 구간</text>

<rect x="398" y="168" width="316" height="56" rx="6" fill="#ffffff" stroke="#5eb39c"/>
<text x="556" y="190" font-family="Segoe UI, sans-serif" font-size="12" font-weight="700" fill="#0f766e" text-anchor="middle">색공간 변환 (필요할 때만)</text>
<text x="556" y="209" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#4b5563" text-anchor="middle">WorkingColorSpace 3x3 행렬 · 11장</text>

<g stroke="#0f766e" stroke-width="1.8" fill="none">
<path d="M209 228 L 209 252"/><path d="M204 245 L 209 253 L 214 245"/>
</g>

<!-- scene color -->
<rect x="46" y="258" width="668" height="48" rx="6" fill="#e8f7f2" stroke="#3f9c85"/>
<text x="380" y="278" font-family="Segoe UI, sans-serif" font-size="12.5" font-weight="700" fill="#0f766e" text-anchor="middle">Scene Color: PF_FloatRGBA (FP16), linear, radiance × PreExposure</text>
<text x="380" y="296" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#4b5563" text-anchor="middle">값의 상한이 없다. TexCreate_SRGB가 붙지 않는다. 09장</text>

<g stroke="#8a6116" stroke-width="1.8" fill="none">
<path d="M380 310 L 380 352"/><path d="M375 345 L 380 353 L 385 345"/>
</g>
<text x="388" y="330" font-family="Segoe UI, sans-serif" font-size="10" fill="#8a6116">톤커브 + 인코딩이 3D LUT 하나로 (10장)</text>

<!-- bottom -->
<rect x="46" y="358" width="200" height="42" rx="6" fill="#ffffff" stroke="#c9a95f"/>
<text x="146" y="376" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#4b5563" text-anchor="middle">sRGB / Rec709 백버퍼</text>
<text x="146" y="392" font-family="Consolas, monospace" font-size="10" fill="#8a8f9c" text-anchor="middle">LinearToSrgb</text>

<rect x="266" y="358" width="200" height="42" rx="6" fill="#ffffff" stroke="#c9a95f"/>
<text x="366" y="376" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#4b5563" text-anchor="middle">HDR 디스플레이 (PQ)</text>
<text x="366" y="392" font-family="Consolas, monospace" font-size="10" fill="#8a8f9c" text-anchor="middle">LinearToST2084</text>

<rect x="486" y="358" width="228" height="42" rx="6" fill="#ffffff" stroke="#c9a95f"/>
<text x="600" y="376" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#4b5563" text-anchor="middle">그 위에 UI 합성</text>
<text x="600" y="392" font-family="Consolas, monospace" font-size="10" fill="#8a8f9c" text-anchor="middle">Slate가 자체 인코딩 · 12장</text>
</svg>
<div class="scene-cap">노란 띠가 인코딩된 공간, 초록 띠가 linear 공간이다. 색은 최소 두 번 경계를 넘는다. 들어올 때 디코드되고 나갈 때 인코딩된다. 위쪽 네 개의 입력은 경계를 넘는 방식이 서로 다르다. 텍스처와 GBufferC는 하드웨어 샘플러가 공짜로 처리하고, FColor는 C++ 코드가 룩업 테이블로, Slate는 셰이더가 직접 처리한다. 이 차이가 12장의 실무 버그 목록으로 이어진다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
그림에서 눈여겨볼 것이 두 가지 있다. 첫째, <strong>linear 구간이 압도적으로 넓다.</strong> 렌더링의 거의 모든 계산은 linear 공간에서 이루어지고, 인코딩된 공간은 입력과 출력 단계에만 있다. 둘째, <strong>경계를 넘는 방법이 입력마다 다르다.</strong> 텍스처는 하드웨어가 처리하므로 셰이더 코드에 아무 흔적이 없고, <code>FColor</code>는 C++ 함수 호출이 필요하고, Slate는 셰이더가 직접 인코딩한다. 이 세 가지 중 어느 방식인지를 모르면 변환을 빼먹거나 두 번 하게 되고, 그것이 색 버그의 거의 전부다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">07 — 텍스처</span>
</div>

# sRGB 옵션이 DXGI 포맷까지 내려가는 과정

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
00장의 질문으로 돌아가자. <code>sRGB</code> 체크박스는 무엇을 바꾸는가. UE 5.8 소스를 따라가면 그 한 비트가 여섯 단계를 거쳐 GPU의 텍스처 포맷 이름을 바꾸는 것으로 끝난다. 시작점은 <code>UTexture</code>의 1비트 프로퍼티다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Classes/Engine/Texture.h (UE 5.8)</span><span class="cm">/** Whether Texture and its source are in SRGB Gamma color space.  Can only be used with 8-bit and</span>
<span class="cm">    compressed formats.  This should be unchecked if using alpha channels individually as masks. */</span>
<span class="fn">UPROPERTY</span>(EditAnywhere, BlueprintReadWrite, Category=Texture, meta=(DisplayName=<span class="str">"sRGB"</span>), AssetRegistrySearchable)
<span class="ty">uint8</span> SRGB:<span class="num">1</span>;</div>

<p style="color:var(--text2);line-height:1.85;">
주석의 "8bit and compressed formats"가 02장의 결론과 정확히 같다. 인코딩은 비트가 부족할 때만 쓴다. 이 비트는 임포트 시점에 <code>GetDefaultSRGB()</code>가 결정하는데, 이 함수의 주석이 <code>UTexture::SRGB</code>의 정체를 가장 정확하게 설명한다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/TextureUtilitiesCommon/Private/TextureImportSettings.cpp (UE 5.8)</span><span class="kw">bool</span> <span class="fn">GetDefaultSRGB</span>(TextureCompressionSettings TC, ETextureSourceFormat ImportImageFormat, <span class="kw">bool</span> ImportImageSRGB)
{
	<span class="cm">// Texture-&gt;SRGB sets the gamma correction of the platform texture we make</span>
	<span class="cm">//	so this is not just = ImportImageSRGB</span>
	<span class="kw">if</span> ( TC == TC_Default || TC == TC_EditorIcon ) {
		<span class="kw">if</span> ( ERawImageFormat::<span class="fn">GetFormatNeedsGammaSpace</span>(...) ) {
			<span class="cm">// note that texture SRGB flag in this case affects both the source interpretation and the platform encoding</span>
			<span class="kw">return</span> ImportImageSRGB;
		} <span class="kw">else</span> {
			<span class="cm">// counter-intuitively, U16 and F32 always want SRGB *on*</span>
			<span class="cm">//	the source will be treated as linear no matter what we set SRGB to</span>
			<span class="cm">//  SRGB will only affect the Platform encoding, so we prefer that to be sRGB color space</span>
			<span class="kw">return</span> <span class="kw">true</span>;
		}
	} <span class="kw">else</span> {
		<span class="cm">// TC_HDR, NormalMap, etc. we want SRGB off</span>
		<span class="cm">// TC_Grayscale we would prefer to have SRGB on, but default to off because</span>
		<span class="cm">//	G8 + SRGB is not supported well</span>
		<span class="kw">return</span> <span class="kw">false</span>;
	}
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 주석에서 실무에 가장 중요한 문장은 두 번째 줄이다. <strong><code>UTexture::SRGB</code>는 의미가 두 개 겹쳐진 플래그다.</strong> 소스 이미지를 어떻게 해석할지와, 빌드 결과물을 어떻게 인코딩할지를 한 비트가 동시에 결정한다. 8bit 소스(PNG, JPG 등)일 때는 두 의미가 다 걸리고, 16bit나 32bit float 소스일 때는 소스가 무조건 linear로 해석되므로 이 비트는 결과물의 인코딩만 정한다. 그래서 float 소스를 임포트할 때 sRGB가 기본으로 켜지는 것이 "직관에 반한다"고 주석이 직접 언급한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
어떤 컴프레션 세팅에서 이 비트가 강제로 꺼지는지도 코드가 명확히 정해 두었다. 목록은 넷뿐이다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Private/Texture.cpp (UE 5.8)</span><span class="cm">// UTexture::ValidateSettingsAfterImportOrEdit. PostEditChangeProperty가 이 함수를 부른다</span>
<span class="cm">// check TC_ CompressionSettings that should have SRGB off</span>
<span class="kw">const</span> <span class="kw">bool</span> bPreventSRGB = CompressionSettings == TC_Alpha
	|| CompressionSettings == TC_Normalmap
	|| CompressionSettings == TC_Masks
	|| UE::TextureDefines::<span class="fn">IsHDR</span>(CompressionSettings);
<span class="kw">if</span> (bPreventSRGB &amp;&amp; SRGB == <span class="kw">true</span>) { SRGB = <span class="kw">false</span>; bRequiresNotifyMaterials = <span class="kw">true</span>; }</div>

<p style="color:var(--text2);line-height:1.85;">
<code>TC_Alpha</code>, <code>TC_Normalmap</code>, <code>TC_Masks</code>, 그리고 HDR 계열이다. 왜 이 넷인가. 답은 03장의 규칙을 뒤집어 보면 나온다. <strong>sRGB 인코딩은 "이 숫자가 사람이 보는 밝기다"라고 가정할 때만 옳다.</strong> 노멀맵의 값은 방향 벡터의 성분이고, roughness는 표면 거칠기이고, 마스크는 0 또는 1의 스위치다. 이들은 빛의 양이 아니므로 sRGB 곡선을 씌울 이유가 없고, 씌우면 값이 그냥 왜곡된다. albedo만 sRGB를 켜는 이유가 이것이다. albedo는 "이 표면이 빛을 얼마나 반사하는가"라는 밝기 값이고, 사람이 눈으로 보고 고른 색이므로 눈의 밝기 감각에 맞춰 만든 sRGB 곡선과 맞아떨어진다.
</p>

<div class="callout callout-warn">
<div class="callout-title">강제되지 않는 것들을 조심하라</div>
<p>위 목록에 없는 세팅은 sRGB가 켜진 상태로 남을 수 있다. <code>TC_Grayscale</code>, <code>TC_VectorDisplacementmap</code>, <code>TC_DistanceFieldFont</code>, <code>TC_EditorIcon</code>이 그렇다. 특히 <code>TC_Grayscale</code>은 위 주석이 밝힌 대로 "켜는 게 맞지만 G8 + sRGB가 하드웨어에서 잘 지원되지 않아서" 기본을 끈 것이고, 실제로 타깃 플랫폼이 지원하지 않으면 <code>Texture.cpp</code>가 되돌려 버린다. 즉 이 세팅들은 엔진이 대신 판단해 주지 않으므로 프로그래머가 직접 정해야 한다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
비트가 정해졌다면 다음은 전달이다. 여기서 반드시 알아 둘 사실이 하나 있다. <strong><code>EPixelFormat</code>에는 sRGB 변형이 없다.</strong> <code>PF_DXT1</code>은 하나뿐이고 <code>PF_DXT1_SRGB</code> 같은 것은 존재하지 않는다. sRGB 여부는 전부 별도의 생성 플래그로만 전달된다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/RHI/Public/RHIDefinitions.h · Runtime/Engine/Private/Rendering/StreamableTextureResource.cpp (UE 5.8)</span><span class="cm">// 플래그 정의: 픽셀 포맷이 아니라 텍스처 생성 플래그다</span>
<span class="cm">// Texture is encoded in sRGB gamma space</span>
SRGB = <span class="num">1</span>ull &lt;&lt; <span class="num">4</span>,      <span class="cm">// 별칭: TexCreate_SRGB</span>

<span class="cm">// FStreamableTextureResource 생성자에서 UTexture::SRGB를 플래그로 옮긴다</span>
bSRGB = InOwner-&gt;SRGB;
CreationFlags =
	  (InOwner-&gt;SRGB ? TexCreate_SRGB : TexCreate_None)
	| (<span class="fn">ShouldAllowPlatformTiling</span>(InOwner) ? TexCreate_OfflineProcessed : TexCreate_None)
	| TexCreate_ShaderResource
	| (InOwner-&gt;bNoTiling ? TexCreate_NoTiling : TexCreate_None);</div>

<p style="color:var(--text2);line-height:1.85;">
이 플래그가 <code>FRHITextureCreateDesc</code>에 실려 RHI로 내려가고, D3D12에서는 뷰를 만들 때 실제 DXGI 포맷으로 번역된다. 여기가 체인의 끝이다. 눈여겨볼 것은 리소스 자체는 TYPELESS로 만들고 <strong>뷰에서 sRGB 여부를 고른다</strong>는 점이다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/RHICore/Internal/DXGIUtilities.h (UE 5.8)</span><span class="cm">/** Find an appropriate DXGI format for the input format and SRGB setting. */</span>
<span class="kw">inline</span> DXGI_FORMAT <span class="fn">FindShaderResourceFormat</span>(DXGI_FORMAT InFormat, <span class="kw">bool</span> bSRGB)
{
	<span class="kw">if</span> (bSRGB) { <span class="kw">switch</span> (InFormat) {
		<span class="kw">case</span> DXGI_FORMAT_B8G8R8A8_TYPELESS: <span class="kw">return</span> DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
		<span class="hl"><span class="kw">case</span> DXGI_FORMAT_BC1_TYPELESS:      <span class="kw">return</span> DXGI_FORMAT_BC1_UNORM_SRGB;</span>
		... BC2 / BC3 / BC7_UNORM_SRGB; }; }
	<span class="kw">else</span> { ... BC1_TYPELESS → BC1_UNORM ... }
}</div>

<p style="color:var(--text2);line-height:1.85;">
즉 albedo 텍스처의 최종 정체는 <code>DXGI_FORMAT_BC1_UNORM_SRGB</code>다. UNORM<span class="fn-note"><input type="checkbox" id="fn-unorm" class="fn-toggle"><label for="fn-unorm" class="fn-ref">6</label><span class="fn-body"><strong>UNORM(unsigned normalized):</strong> 정수 비트 패턴을 0~1 실수로 자동 변환해 주는 포맷 규약. 8bit UNORM은 저장된 0~255를 셰이더에서 읽을 때 255로 나눠 0.0~1.0으로 준다. 이 나누기는 sRGB 디코드와 무관한 별개의 단계이며, <code>_SRGB</code> 접미사가 붙으면 나눈 뒤에 sRGB 디코드까지 하드웨어가 이어서 해 준다.</span></span> 은 정수를 0~1로 펴는 규약이고 <code>_SRGB</code> 접미사가 그다음 디코드를 담당한다. BC1<span class="fn-note"><input type="checkbox" id="fn-bc" class="fn-toggle"><label for="fn-bc" class="fn-ref">7</label><span class="fn-body"><strong>BC1(Block Compression 1, 옛 이름 DXT1):</strong> 4x4 텍셀 블록을 8바이트로 줄이는 GPU 내장 압축 포맷. 블록마다 대표 색 두 개를 저장하고 각 텍셀은 그 사이를 보간하는 2비트 인덱스만 갖는다. 압축을 푸는 일은 GPU가 샘플링할 때 처리하며, sRGB 디코드는 그 뒤에 이어진다.</span></span> 은 블록 압축 포맷의 이름이다. Vulkan에서는 같은 역할을 <code>VK_FORMAT_BC1_RGBA_SRGB_BLOCK</code>이 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그러면 셰이더 쪽에는 무엇이 생기는가. <strong>아무것도 생기지 않는다.</strong> 머티리얼 컴파일러가 sRGB 텍스처 샘플에 붙이는 함수는 항등 함수다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Engine/Shaders/Private/MaterialTexture.ush (UE 5.8)</span><span class="cm">// SAMPLERTYPE_Color 경로. 이름과 달리 아무 변환도 하지 않는다</span>
MaterialFloat4 <span class="fn">ProcessMaterialColorTextureLookup</span>(MaterialFloat4 TextureValue)
{
	<span class="kw">return</span> TextureValue;
}

<span class="cm">// SAMPLERTYPE_LinearColor 경로도 똑같이 항등이다</span>
MaterialFloat4 <span class="fn">ProcessMaterialLinearColorTextureLookup</span>(MaterialFloat4 TextureValue)
{
	<span class="kw">return</span> TextureValue;
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 두 함수가 똑같다는 사실이 07장에서 가장 중요한 결론이다. <strong>Color와 LinearColor의 셰이더 코드에는 차이가 없고, 차이는 전부 텍스처 포맷에 있다.</strong> 따라서 <code>SRGB</code> 플래그를 틀리게 두면 셰이더에는 어떤 보정 코드도 생기지 않고, 컴파일 에러도 나지 않고, 값만 조용히 틀린다. 머티리얼의 샘플러 타입은 이 플래그의 <strong>결과를 반영하는 라벨</strong>일 뿐이며, 둘이 어긋나면 머티리얼 컴파일 단계에서 다음 문구로 잡아 준다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Public/Materials/MaterialExpressionUtils.cpp (UE 5.8)</span><span class="cm">// 샘플러 타입과 UTexture::SRGB가 어긋날 때 나오는 에러 문구 원문</span>
<span class="str">"Sampler type is %s, should be %s for %s"</span>
<span class="str">"To use '%s' as sampler type, SRGB must be disabled for %s"</span>

<span class="cm">// 그 정답 매핑도 결국 SRGB 비트에서 파생된다</span>
<span class="kw">case</span> TC_Grayscale: <span class="kw">return</span> Texture-&gt;SRGB ? SAMPLERTYPE_Grayscale : SAMPLERTYPE_LinearGrayscale;
<span class="kw">case</span> TC_Masks:     <span class="kw">return</span> SAMPLERTYPE_Masks;
<span class="kw">default</span>:           <span class="kw">return</span> Texture-&gt;SRGB ? SAMPLERTYPE_Color : SAMPLERTYPE_LinearColor;</div>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 밉맵 쪽을 확인하자. 03장에서 밉맵은 반드시 linear에서 평균내야 한다고 했는데, UE는 이를 assert로 강제한다. 오프라인 텍스처 빌드는 이미지를 32bit float linear로 펴 놓고 그 상태에서 밉 체인을 만든다.
</p>

<div class="code-block"><span class="code-lang">C++ — Developer/TextureCompressor/Private/TextureCompressorModule.cpp (UE 5.8)</span><span class="cm">// 밉 생성에 들어가기 전 불변식: 32bit float이고 linear여야 한다</span>
<span class="fn">check</span>(BaseImage.Format == ERawImageFormat::RGBA32F &amp;&amp; BaseImage.GammaSpace == EGammaSpace::Linear);

<span class="cm">// 그리고 최종 인코딩은 GPU에 바인딩될 감마 공간을 따른다</span>
<span class="cm">// DestGamma is how the texture will be bound to GPU</span>
<span class="kw">bool</span> bSRGB = BuildSettings.<span class="fn">GetDestGammaSpace</span>() == EGammaSpace::sRGB;
<span class="fn">check</span>( !bHDRImage || !bSRGB );</div>

<p style="color:var(--text2);line-height:1.85;">
런타임 GPU 밉 생성 쪽은 사정이 다르고, 그 차이가 sRGB의 한 가지 제약을 드러낸다. <strong>하드웨어 sRGB 인코딩은 쓰기에는 적용되지 않는다.</strong> 읽을 때 디코드해 주는 기능은 있지만, UAV<span class="fn-note"><input type="checkbox" id="fn-uav" class="fn-toggle"><label for="fn-uav" class="fn-ref">8</label><span class="fn-body"><strong>SRV / UAV(Shader Resource View / Unordered Access View):</strong> 같은 텍스처 메모리를 셰이더에서 어떻게 볼지 정하는 두 종류의 뷰. SRV는 읽기 전용이고 샘플러를 통과하므로 필터링과 sRGB 디코드가 붙는다. UAV는 임의 위치 쓰기가 가능한 대신 샘플러를 거치지 않으며, D3D12와 Vulkan 모두 UAV에 sRGB 변형 포맷을 허용하지 않는다.</span></span> 로 쓸 때 자동으로 인코딩해 주는 기능은 규격에 없다. 그래서 컴퓨트 셰이더로 밉을 만들 때는 인코딩을 손으로 해야 한다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Engine/Shaders/Private/ComputeGenerateMips.usf (UE 5.8)</span><span class="cm">// SampleLevel은 SRV라서 하드웨어가 디코드해 linear를 준다. 보간도 linear에서 일어난다</span>
<span class="cm">// 반면 UAV 쓰기에는 하드웨어 인코딩이 없으므로 LinearToSrgb를 직접 호출한다</span>
<span class="kw">#if</span> GENMIPS_SRGB
    <span class="ty">half4</span> outColor = MipInSRV.<span class="fn">SampleLevel</span>(MipSampler, UV, <span class="num">0</span>);
    outColor = <span class="fn">half4</span>(<span class="fn">LinearToSrgb</span>(outColor.xyz), outColor.w);
<span class="kw">#else</span>
    <span class="ty">float4</span> outColor = MipInSRV.<span class="fn">SampleLevel</span>(MipSampler, UV, <span class="num">0</span>);
<span class="kw">#endif</span></div>

<p style="color:var(--text2);line-height:1.85;">
이 여덟 줄이 07장 전체를 요약한다. 읽는 쪽은 하드웨어가 공짜로 디코드하고 필터링도 linear에서 해 주지만, 쓰는 쪽은 프로그래머가 해야 한다. <strong>렌더타깃이나 UAV에 색을 직접 써 넣는 코드를 작성할 때는, 그 대상이 인코딩된 값을 기대하는지 직접 확인하고 그에 맞게 변환한 값을 써야 한다.</strong>
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">08 — 두 타입</span>
</div>

# FColor와 FLinearColor는 왜 별개 타입인가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
텍스처는 하드웨어가 알아서 해 주지만, C++ 코드에서 색을 다룰 때는 프로그래머가 직접 챙겨야 한다. UE는 이를 <strong>타입으로 구분</strong>하는 방식으로 해결했다. <code>FColor</code>는 채널당 8bit 정수이고 sRGB 공간이라고 가정한다. <code>FLinearColor</code>는 채널당 float이고 linear다. 헤더 주석이 이 구분을 명시한다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Core/Public/Math/Color.h (UE 5.8)</span><span class="cm">//	FColor</span>
<span class="cm">//	Stores a color with 8 bits of precision per channel.</span>
<span class="cm">//	Note: Linear color values should always be converted to gamma space before stored in an FColor,</span>
<span class="cm">//	as 8 bits of precision is not enough to store linear space colors!</span>
<span class="cm">//	This can be done with FLinearColor::ToFColor(true)</span></div>

<p style="color:var(--text2);line-height:1.85;">
주석의 근거가 02장에서 계산한 그 숫자다. linear 값을 8bit에 그대로 담으면 어두운 영역의 계조가 13배 부족해진다. 그래서 8bit 타입인 <code>FColor</code>에는 반드시 인코딩된 값만 담아야 하고, 엔진 코드도 그렇게 가정하고 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
디코드 방향은 생성자 하나로 되어 있고, 구현은 256칸 룩업 테이블이다. 정확한 sRGB 곡선을 컴파일 타임 상수로 미리 계산해 둔 것이다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Core/Public/Math/Color.h (UE 5.8)</span><span class="cm">/** Static lookup table used for fast FColor -&gt; FLinearColor conversion. sRGB</span>
<span class="cm"> *  Color &gt; 0.04045 ? pow( Color * (1.0 / 1.055) + 0.0521327, 2.4 ) : Color * (1.0 / 12.92);  */</span>
<span class="kw">static</span> <span class="kw">constexpr</span> <span class="kw">float</span> sRGBToLinearTable[] = { <span class="num">0.0f</span>, <span class="num">0.000303526983548838f</span>, ... <span class="num">1.0f</span> };

<span class="cm">// 생성자는 RGB만 테이블을 타고, 알파는 그냥 255로 나눈다</span>
<span class="kw">constexpr</span> FLinearColor::<span class="fn">FLinearColor</span>(<span class="kw">const</span> FColor&amp; Color)
	: R(sRGBToLinearTable[Color.R]), G(...), B(...)
	, A(<span class="kw">static_cast</span>&lt;<span class="kw">float</span>&gt;(Color.A) * (<span class="num">1.0f</span> / <span class="num">255.0f</span>))
{}</div>

<p style="color:var(--text2);line-height:1.85;">
테이블의 두 번째 값 <code>0.000303526983548838</code>이 02장에서 계산한 sRGB 8bit의 가장 어두운 쪽 간격 0.000304와 같은 숫자다. 주석의 공식에서 <code>0.0521327</code>은 <code>0.055 / 1.055</code>를 미리 계산해 둔 것이고, 지수가 2.4이므로 이 테이블은 <strong>순수한 pow(2.2)가 아니라 정확한 sRGB 곡선</strong>이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
알파가 테이블을 타지 않는 것도 중요하다. 알파는 밝기가 아니라 섞는 비율이므로 sRGB 곡선을 씌울 이유가 없고, 그래서 언제나 linear다. 07장에서 <code>TC_Alpha</code>가 sRGB 강제 off 목록에 있던 것과 같은 이유다.
</p>

<p style="color:var(--text2);line-height:1.85;">
디코드 경로는 세 개가 있고, 셋을 구분해서 쓸 줄 알아야 한다.
</p>

<div class="data-table">
<table>
<tr><th>함수</th><th>하는 일</th><th>쓰는 자리</th></tr>
<tr><td><code>FLinearColor(FColor)</code><br><code>FromSRGBColor()</code></td><td>정확한 sRGB 곡선으로 디코드. 둘은 완전히 같고 뒤쪽은 의도를 드러내는 별칭</td><td>기본. 컬러 피커나 이미지에서 온 색</td></tr>
<tr><td><code>FromPow22Color()</code></td><td><code>pow(x, 2.2)</code> 테이블로 디코드. 직선 구간이 없다</td><td>레거시 콘텐츠(<code>bUseLegacyGamma</code>)의 소스 해석 재현</td></tr>
<tr><td><code>ReinterpretAsLinear()</code></td><td>곡선 없이 255로만 나눈다</td><td>이미 linear인 8bit 데이터. 주석이 "GPU 규격의 U8↔float 변환과 일치"라고 명시</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
역방향인 인코딩은 <code>ToFColor(bool bSRGB)</code>가 진입점이고, 안에서 <code>ToFColorSRGB()</code>와 <code>QuantizeRound()</code>로 갈린다. 구현이 흥미롭다. 02장의 공식을 그대로 쓰지 않고, float의 비트 패턴을 이용한 테이블 보간을 쓴다. 정확도를 주석이 직접 밝혀 둔다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Core/Private/Math/Color.cpp (UE 5.8)</span><span class="cm">// fast Linear to SRGB uint8 conversion</span>
<span class="cm">// https://gist.github.com/rygorous/2203834</span>
<span class="cm">//</span>
<span class="cm">// round-trips exactly</span>
<span class="cm">// quantization bucket boundaries vary by max of 0.11%</span>
<span class="cm">// biggest difference at i = 1</span>

FColor FLinearColor::<span class="fn">ToFColorSRGB</span>() <span class="kw">const</span>
{
	<span class="cm">// The convention used here in all channels is that NaNs</span>
	<span class="cm">// convert to 0, as do negative values, and out-of-range positive values convert to 255.</span>
<span class="kw">#if</span> PLATFORM_CPU_X86_FAMILY &amp;&amp; PLATFORM_ENABLE_VECTORINTRINSICS
	<span class="kw">return</span> <span class="fn">ConvertLinearToSRGBSSE2</span>(*<span class="kw">this</span>);
<span class="kw">#else</span>
	<span class="kw">return</span> <span class="fn">FColor</span>(<span class="fn">stbir__linear_to_srgb_uchar_fast</span>(R), ..., (<span class="ty">uint8</span>)(<span class="num">0.5f</span> + <span class="fn">Clamp01NansTo0</span>(A)*<span class="num">255.f</span>));
<span class="kw">#endif</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
주석의 "round-trips exactly"는 실무에서 특히 중요한 부분이다. <code>FColor</code>를 디코드해서 <code>FLinearColor</code>로 만들고 다시 인코딩하면 원래 바이트가 정확히 복원된다. 즉 왕복 자체는 손실이 없고, 손실은 <strong>linear 값을 8bit에 새로 담을 때</strong><span class="fn-note"><input type="checkbox" id="fn-quant" class="fn-toggle"><label for="fn-quant" class="fn-ref">9</label><span class="fn-body"><strong>8bit에 새로 담을 때 손실이 생기는 이유:</strong> float linear 값은 연속적인 값이지만 8bit 저장값은 0~255의 256가지뿐이다. 그래서 인코딩한 결과를 가장 가까운 정수로 반올림해야 하고(<code>QuantizeRound</code>), 이 반올림에서 원래 값과의 차이가 생긴다. 예를 들어 linear 0.5는 인코딩하면 187.5인데 저장은 188이 되고, 다시 디코드하면 0.503이다. 한 번 반올림된 값은 다시 디코드해도 정확히 원래 값으로 돌아오지 않는다. 반대로 이미 8bit인 <code>FColor</code>를 디코드해서 float로 만들고 다시 인코딩하는 경우는, float가 8bit보다 훨씬 정밀해서 중간에 정보가 사라지지 않으므로 반올림하면 원래 정수로 정확히 돌아온다. 왕복은 손실이 없고 새로 담을 때만 손실이 생기는 이유가 이것이다.</span></span>만 생긴다. NaN을 0으로 보내는 규칙을 주석에 명시해 둔 것도 기억해 둘 만하다. HDR 계산 결과에는 NaN이 섞일 수 있고, 이것이 8bit로 내려갈 때 어떤 값이 될지가 정해져 있지 않으면 플랫폼마다 화면이 달라진다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그리고 이 장에서 가장 흥미로운 코드가 남아 있다. <strong><code>FColor</code>의 <code>FLinearColor</code> 생성자는 private이고 구현이 없다.</strong>
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Core/Public/Math/Color.h (UE 5.8)</span><span class="kw">private</span>:
	<span class="cm">/**</span>
<span class="cm">	 * Please use .ToFColor(true) on FLinearColor if you wish to convert from FLinearColor to FColor,</span>
<span class="cm">	 * with proper sRGB conversion applied.</span>
<span class="cm">	 *</span>
<span class="cm">	 * Note: Do not implement or make public.  We don't want people needlessly and implicitly converting between</span>
<span class="cm">	 * FLinearColor and FColor.  It's not a free conversion.</span>
<span class="cm">	 */</span>
	<span class="kw">explicit</span> <span class="fn">FColor</span>(<span class="kw">const</span> FLinearColor&amp; LinearColor);</div>

<p style="color:var(--text2);line-height:1.85;">
선언만 있고 정의가 없으므로, 실수로 이 변환을 쓰면 컴파일은 통과하고 <strong>링크 단계에서 에러가 난다.</strong> 인코딩 변환이 암묵적으로 일어나는 것을 언어 수준에서 막아 둔 것이다. 05장의 "숫자만 넘기고 나머지 둘은 관례로 남긴다"는 문제를 UE가 어떻게 처리했는지를 보여주는 대표적인 코드다. 이 링크 에러를 만났다면 해결책은 캐스팅이 아니라 <code>ToFColor(true)</code>를 붙이는 것이다.
</p>

<div class="callout callout-purple">
<div class="callout-title">Quantize는 사라졌고 이유가 있다</div>
<p>UE 5.8에는 <code>FLinearColor::Quantize()</code>가 없고 <code>QuantizeRound()</code>와 <code>QuantizeFloor()</code>로 갈라져 있다. 후자의 주석이 이유를 밝힌다. <code>Uses floor quantization, which does not match the GPU standard conversion... Do NOT use this for graphics or textures or images, use QuantizeRound instead.</code> 즉 float을 8bit로 줄일 때 내림을 쓰면 GPU가 UNORM을 변환하는 방식과 어긋나서, CPU와 GPU 결과가 1씩 달라진다. 색 코드에서 CPU와 GPU 결과를 비교할 일이 있으면 이 함수 선택이 문제의 원인일 수 있다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
반대로 <strong>변환이 아예 일어나지 않는 자리</strong>도 알아 둬야 한다. 세 곳이 대표적이다. 첫째, 비트 패킹 함수들(<code>FromHex</code>, <code>ToPackedARGB</code>, <code>ToHex</code>)은 순수한 시프트와 OR이며 인코딩 상태를 건드리지 않는다. 둘째, 머티리얼에 넘어가는 상수 색은 아무 변환 없이 그대로 셰이더에 도달한다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Private/Materials/MaterialExpressions.cpp (UE 5.8)</span><span class="cm">// FLinearColor 멤버를 float 네 개로 그대로 넘긴다. 인코딩 변환 지점이 없다</span>
<span class="ty">int32</span> UMaterialExpressionConstant4Vector::<span class="fn">Compile</span>(FMaterialCompiler* Compiler, <span class="ty">int32</span> OutputIndex)
{
	<span class="kw">return</span> Compiler-&gt;<span class="fn">Constant4</span>(Constant.R, Constant.G, Constant.B, Constant.A);
}</div>

<p style="color:var(--text2);line-height:1.85;">
즉 머티리얼 에디터의 컬러 피커에서 고른 값은 <code>FLinearColor</code>로 저장되고 비트 그대로 셰이더에 도달한다. 셰이더는 이미 linear라고 가정한다. 그래서 코드에서 셰이더에 상수 색을 넘길 때는 <strong>반드시 <code>FLinearColor</code>로 넘겨야</strong> 하고, 디자이너가 준 헥스 코드(sRGB 공간)를 쓸 거라면 먼저 디코드해야 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
셋째가 실수하기 쉬운 자리다. <strong>vertex color는 <code>FColor</code>로 저장되지만 셰이더에는 디코드 없이 도착한다.</strong> D3D12의 정점 요소 포맷이 sRGB 변형이 아니기 때문이다.
</p>

<div class="code-block"><span class="code-lang">C++ · HLSL — D3D12VertexDeclaration.cpp · LocalVertexFactory.ush (UE 5.8)</span><span class="cm">// 정점 색의 포맷. _SRGB 변형이 아니라 그냥 UNORM이다</span>
<span class="kw">case</span> VET_Color: D3DElement.Format = DXGI_FORMAT_B8G8R8A8_UNORM; <span class="kw">break</span>;

<span class="cm">// 셰이더 쪽에서 하는 일은 채널 순서를 바꾸는 스위즐뿐이다</span>
Intermediates.Color = Input.Color FCOLOR_COMPONENT_SWIZZLE; <span class="cm">// Swizzle vertex color.</span></div>

<p style="color:var(--text2);line-height:1.85;">
결과적으로 vertex color는 "8bit 값을 255로 나눈 것"으로 셰이더에 들어오고, 보간도 그 상태에서 일어난다. 그래서 C++ 쪽에서 vertex color를 만들거나 읽을 때 <code>FLinearColor(FColor)</code>로 sRGB 디코드를 하면 <strong>GPU가 보는 값과 어긋난다.</strong> 이 자리에서 GPU 거동과 일치하는 함수는 <code>ReinterpretAsLinear()</code>다. 실제로 스켈레탈 메시 임포터가 그렇게 쓰고 있다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">09 — Scene Color</span>
</div>

# scene color가 linear라는 것을 소스에서 확인한다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
04장에서 HDR 렌더링이 linear를 전제한다고 했다. UE 소스에서 이 전제를 확인할 수 있는 지점이 네 군데 있다. 포맷 기본값, sRGB 플래그가 붙는 곳, base pass가 쓰는 값의 스케일, 그리고 8bit로 내려갈 때 명시적으로 삽입되는 인코딩이다. 순서대로 보자.
</p>

<p style="color:var(--text2);line-height:1.85;">
첫째, 포맷이다. <code>r.SceneColorFormat</code>의 기본값이 float이고, 지원되지 않을 때의 대체 경로도 float이다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Private/SceneTexturesConfig.cpp (UE 5.8)</span><span class="kw">static</span> EPixelFormat <span class="fn">GetSceneColorFormat</span>(<span class="kw">bool</span> bRequiresAlphaChannel)
{
	EPixelFormat Format = PF_FloatRGBA;   <span class="cm">// 기본값</span>
	...
	<span class="kw">case</span> <span class="num">0</span>: Format = PF_R8G8B8A8; <span class="kw">break</span>;
	<span class="kw">case</span> <span class="num">1</span>: Format = PF_A2B10G10R10; <span class="kw">break</span>;
	<span class="kw">case</span> <span class="num">2</span>: Format = PF_FloatR11G11B10; <span class="kw">break</span>;
	<span class="kw">case</span> <span class="num">3</span>: Format = PF_FloatRGB; <span class="kw">break</span>;
	<span class="hl"><span class="kw">case</span> <span class="num">4</span>: <span class="kw">break</span>;                  <span class="cm">// default = PF_FloatRGBA (FP16)</span></span>
	<span class="kw">case</span> <span class="num">5</span>: Format = PF_A32B32G32R32F; <span class="kw">break</span>;
	<span class="kw">if</span> (!GPixelFormats[Format].Supported) Format = PF_FloatRGBA;   <span class="cm">// fallback도 float</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
CVar 도움말이 8bit 옵션에 대해 무엇이라고 쓰는지가 결정적이다. <code>0: PF_B8G8R8A8 32Bit (mostly for testing, likely to unusable with HDR)</code>. 엔진 자신이 8bit scene color는 HDR에 쓸 수 없다고 적어 둔 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
둘째, sRGB 플래그다. scene color에 <code>TexCreate_SRGB</code>가 붙는 경로는 <strong>단 하나</strong>이고, 그것은 모바일 LDR이다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Private/SceneTexturesConfig.cpp (UE 5.8)</span><span class="cm">// 데스크톱 Deferred 경로에서는 이 값이 항상 TexCreate_None이다</span>
<span class="kw">const</span> ETextureCreateFlags sRGBFlag =
	(bIsMobilePlatform &amp;&amp; <span class="fn">IsMobileColorsRGB</span>()) ? TexCreate_SRGB : TexCreate_None;</div>

<p style="color:var(--text2);line-height:1.85;">
셋째, 값의 스케일이다. base pass는 계산한 radiance를 그대로 쓰지 않고 <code>View.PreExposure</code>를 곱해서 쓴다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Engine/Shaders/Private/BasePassPixelShader.usf · PostProcessTonemap.usf (UE 5.8)</span><span class="cm">// base pass가 scene color에 쓰는 값 = linear radiance × PreExposure</span>
<span class="kw">const</span> <span class="kw">float</span> ViewPreExposure = View.PreExposure;
<span class="cm">// We need to multiply pre-exposure by all components including A ...</span>
Out.MRT[<span class="num">0</span>].rgba *= ViewPreExposure;

<span class="cm">// 톤매퍼가 되돌린다. 여기서 다시 절대 단위의 linear가 된다</span>
<span class="ty">half3</span> FinalLinearColor = SceneColor.rgb * SceneColorTint
	* (OneOverPreExposure * GlobalExposure * VignetteMask * LocalExposure);</div>

<p style="color:var(--text2);line-height:1.85;">
왜 이런 스케일이 필요한가. 04장에서 FP16이 약 30스톱<span class="fn-note"><input type="checkbox" id="fn-stop" class="fn-toggle"><label for="fn-stop" class="fn-ref">10</label><span class="fn-body"><strong>스톱(stop):</strong> 사진·영상에서 밝기 차이를 재는 단위. 1스톱은 빛의 양이 2배 또는 절반이 되는 차이이고, n스톱은 2ⁿ배다. EV(Exposure Value)와 같은 눈금이라 EV −14에서 +16까지가 30스톱이다. 30스톱은 2³⁰, 약 10억 배의 밝기 범위다. 카메라 조리개를 한 칸(f-stop) 돌리면 들어오는 빛이 2배씩 바뀌는 데서 온 말이다.</span></span>을 담는다고 했지만, 그 범위는 1.0(EV 0)을 중심으로 아래로 14스톱, 위로 16스톱까지 넓게 펼쳐져 있고, 실제 장면의 밝기는 그중 일부 구간에 몰려 있다. 어두운 실내 장면의 값이 FP16이 정밀도를 잘 쓰는 구간보다 훨씬 아래에 있으면 정밀도를 낭비하고, 반대로 태양이 직접 보이는 장면은 위쪽에서 넘칠 수 있다. 그래서 이전 프레임의 노출값을 미리 곱해 <strong>장면 전체를 FP16이 잘 다루는 구간으로 밀어 넣는다.</strong> CVar 도움말이 이 의도를 그대로 말한다. <code>Fixed pre-exposure offset in EV units ... Default 4 maps to ~[-8;12] of usable exposure range</code>.
</p>

<p style="color:var(--text2);line-height:1.85;">
코딩을 하다 보면 이 사실을 직접 신경 써야 하는 경우가 있다. <strong>scene color를 직접 읽는 코드를 쓸 때는 <code>PreExposure</code>를 나눠야 절대 단위의 linear가 된다.</strong> 그리고 이전 프레임의 scene color를 재사용하는 기능은 두 프레임의 <code>PreExposure</code>가 다르므로 비율로 보정해야 하는데, Lumen이 실제로 그렇게 한다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Renderer/Private/Lumen/LumenReflections.cpp (UE 5.8)</span><span class="cm">// 히스토리를 재사용할 때 두 프레임의 pre-exposure 차이를 비율로 보정한다</span>
PassParameters-&gt;PrevSceneColorPreExposureCorrection =
	View.PreExposure / View.PrevViewInfo.SceneColorPreExposure;</div>

<p style="color:var(--text2);line-height:1.85;">
넷째, scene color가 linear라는 것이 가장 분명하게 드러나는 곳이다. <strong>UE는 값을 8bit로 내릴 때마다 인코딩을 명시적으로 삽입한다.</strong> 반투명 머티리얼이 scene color를 읽는 경로가 그 예다. 이 경로는 8bit 버퍼를 쓰므로 곡선을 씌우고, 읽는 쪽에서 정확히 되돌린다.
</p>

<div class="code-block"><span class="code-lang">HLSL — TranslucentLightingShaders.usf · MaterialTemplate.ush (UE 5.8)</span><span class="cm">/** Encodes HDR linear scene color for storage in the 8 bit light attenuation texture. */</span>
MaterialFloat3 <span class="fn">EncodeSceneColorForMaterialNode</span>(MaterialFloat3 LinearSceneColor)
{	<span class="cm">// Preserving a range from [0, 10] ... more bits of precision in the darks</span>
	<span class="kw">return</span> <span class="fn">pow</span>(LinearSceneColor * <span class="num">.1f</span>, <span class="num">.25f</span>); }

<span class="cm">// 읽는 쪽: Undo the function in EncodeSceneColorForMaterialNode</span>
<span class="ty">float3</span> SampledColor = <span class="fn">pow</span>(EncodedSceneColor.rgb, <span class="num">4</span>) * <span class="num">10</span>;
SampledColor *= View.OneOverPreExposure.xxx;</div>

<p style="color:var(--text2);line-height:1.85;">
주석의 "more bits of precision in the darks"가 02장의 논리와 정확히 같다. 심지어 곡선의 지수도 다르다(0.25제곱이니 실효 감마 4). sRGB 규격을 쓸 이유가 없는 내부 버퍼라서 범위와 정밀도에 맞춰 곡선을 직접 고른 것이다. 이것이 이 글의 규칙을 잘 보여준다. <strong>인코딩은 규격의 문제가 아니라 "비트가 부족할 때 정밀도를 어디에 몰아줄까"의 문제다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
같은 논리가 GBuffer에도 적용되어 있고, 이 부분이 처음 보면 헷갈린다. GBuffer의 여러 타깃 중 <strong>BaseColor를 담는 GBufferC만 하드웨어 sRGB를 쓴다.</strong>
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/RenderCore/Private/GBufferInfo.cpp (UE 5.8)</span><span class="cm">// 다른 타깃은 전부 sRGB=false. GBufferC(BaseColor)만 true이고, 그것도 8bit일 때만</span>
Info.Targets[<span class="num">1</span>].<span class="fn">Init</span>(NormalGBufferFormatTarget, <span class="str">"GBufferA"</span>, <span class="kw">false</span>, ...);
Info.Targets[<span class="num">2</span>].<span class="fn">Init</span>(DiffuseAndSpecularGBufferFormat, <span class="str">"GBufferB"</span>, <span class="kw">false</span>, ...);
<span class="kw">const</span> <span class="kw">bool</span> bLegacyAlbedoSrgb = <span class="kw">true</span>;
<span class="hl">Info.Targets[<span class="num">3</span>].<span class="fn">Init</span>(DiffuseAndSpecularGBufferFormat, <span class="str">"GBufferC"</span>, bLegacyAlbedoSrgb &amp;&amp; !bHighPrecisionGBuffers, ...);</span></div>

<p style="color:var(--text2);line-height:1.85;">
BaseColor만 켜는 이유는 07장의 판단 기준과 같다. BaseColor는 밝기 값이고 나머지(노멀, roughness, metallic 등)는 밝기가 아니다. 그리고 고정밀 모드에서 FP16을 쓰면 이 플래그가 꺼진다. 02장의 마지막 콜아웃에서 말한 "float에는 인코딩이 필요 없다"가 그대로 적용된 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
셰이더 쪽 함수는 07장과 똑같이 항등 함수이고, 주석이 그 이유를 밝힌다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Engine/Shaders/Private/DeferredShadingCommon.ush (UE 5.8)</span><span class="ty">float3</span> <span class="fn">EncodeBaseColor</span>(<span class="ty">float3</span> BaseColor)
{
	<span class="cm">// we use sRGB on the render target to give more precision to the darks</span>
	<span class="kw">return</span> BaseColor;
}

<span class="ty">float3</span> <span class="fn">DecodeBaseColor</span>(<span class="ty">float3</span> BaseColor)
{
	<span class="cm">// we use sRGB on the render target to give more precision to the darks</span>
	<span class="kw">return</span> BaseColor;
}</div>

<p style="color:var(--text2);line-height:1.85;">
함수 이름은 Encode이지만 실제로는 들어온 값을 그대로 돌려준다. 실제 인코딩은 렌더타깃의 sRGB 플래그를 보고 하드웨어가 하고, 셰이더가 다루는 값은 언제나 linear다. <strong>이름은 인코딩 함수인데 그 일은 하드웨어가 한다</strong>는 패턴이 UE 코드 여러 곳에서 반복되므로, 이런 함수를 보고 "쓸모없는 코드"로 읽지 않는 것이 중요하다. 이 함수들은 인코딩이 일어나는 지점을 코드에 표시해 두는 역할을 한다.
</p>

<div class="callout callout-teal">
<div class="callout-title">모바일 LDR은 규칙이 다르다</div>
<p><code>r.MobileHDR=0</code>이면 scene color가 linear가 아니다. base pass 끝에서 감마 인코딩이 붙는데, 정확한 sRGB 곡선이 아니라 <code>sqrt()</code>를 쓴다. 즉 실효 감마 2.0의 근사다. CVar 도움말도 이 경로를 <code>Mobile renders in LDR gamma space. (suggested for unlit games targeting low-end phones)</code>라고 설명한다. 되돌릴 때도 제곱을 쓴다. 플래너 리플렉션 셰이더에 <code>the capture will also be in gamma space, convert to linear: PlanarReflection.rgb *= PlanarReflection.rgb;</code>라는 코드가 그대로 있다. 모바일 LDR 타깃을 다룰 때는 이 글의 04장부터 10장까지가 통째로 적용되지 않으므로 별개의 파이프라인으로 생각해야 한다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">10 — 출력</span>
</div>

# 톤커브와 디스플레이 인코딩은 LUT에 구워져 있다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
렌더링 파이프라인에서 색이 마지막으로 공간을 옮기는 단계다. linear HDR scene color를 받아서 디스플레이가 이해하는 인코딩된 값으로 바꿔야 한다. 04장의 콜아웃에서 이것이 두 단계(범위 압축과 정밀도 배분)라고 했는데, UE 5.8의 구조를 보면 놀라운 사실이 나온다. <strong>톤커브<span class="fn-note"><input type="checkbox" id="fn-tonecurve" class="fn-toggle"><label for="fn-tonecurve" class="fn-ref">11</label><span class="fn-body"><strong>톤커브(tone curve):</strong> HDR 렌더링 결과는 밝기 상한이 없어서 1.0을 훨씬 넘는 값이 나오는데, 디스플레이는 0~1(SDR)이나 정해진 최대 니트까지만 낼 수 있다. 이 넓은 밝기 범위를 디스플레이가 낼 수 있는 범위로 눌러 담는 곡선이 톤커브다. 04장 콜아웃의 "범위 압축"이 이것이다. 단순히 1.0에서 잘라 내면 밝은 부분이 하얗게 날아가므로, 어두운 곳은 거의 그대로 두고 밝은 곳을 완만하게 눌러서 필름 사진처럼 보이게 만든다. UE의 기본 톤커브는 ACES 계열이다. sRGB 인코딩과는 다른 단계다. 톤커브는 "얼마나 밝게 보일지"를 정하고, 인코딩은 그 결과를 8bit에 어떻게 담을지를 정한다.</span></span>도 디스플레이 인코딩도 톤매퍼<span class="fn-note"><input type="checkbox" id="fn-tonemapper" class="fn-toggle"><label for="fn-tonemapper" class="fn-ref">12</label><span class="fn-body"><strong>톤매퍼(tonemapper):</strong> 포스트 프로세스의 마지막 단계에서 linear HDR scene color를 받아 화면에 보낼 최종 색을 만드는 패스. 이름은 톤커브를 적용하는 데서 왔지만, UE에서는 색 그레이딩, 톤커브, 디스플레이 인코딩(sRGB 또는 PQ)에 블룸 합성이나 비네트 같은 마무리 효과까지 한 셰이더에서 처리한다. 셰이더 파일은 <code>PostProcessTonemap.usf</code>다. 이 장에서 보듯 톤커브와 인코딩 자체는 미리 구워 둔 3D LUT에서 가져오고, 톤매퍼 셰이더는 그 LUT를 샘플링해서 적용한다. 이 패스를 지나면 값은 더 이상 linear가 아니다.</span></span> 셰이더 안에서 계산되지 않는다.</strong> 둘 다 3D LUT<span class="fn-note"><input type="checkbox" id="fn-lut" class="fn-toggle"><label for="fn-lut" class="fn-ref">13</label><span class="fn-body"><strong>LUT(Look-Up Table, 룩업 테이블):</strong> 함수를 계산하는 대신 결과를 미리 표로 만들어 두고 찾아 쓰는 방식. 색 보정에서는 입력 RGB 세 값을 좌표로 삼는 3차원 텍스처를 쓴다. UE의 기본 크기는 한 변 32칸이며, 매 프레임 픽셀마다 톤커브를 계산하는 대신 32×32×32 격자만 계산해 두고 픽셀은 보간해서 읽는다.</span></span> 에 미리 구워지고, 톤매퍼는 그 LUT를 한 번 샘플링하는 것으로 끝난다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Engine/Shaders/Private/PostProcessTonemap.usf (UE 5.8)</span><span class="cm">// 톤매퍼 픽셀 셰이더의 핵심 세 줄. 인코딩이 일어나는 지점은 ColorLookupTable 한 곳이다</span>
<span class="ty">half3</span> FinalLinearColor = SceneColor.rgb * SceneColorTint
	* (OneOverPreExposure * GlobalExposure * VignetteMask * LocalExposure);
FinalLinearColor += Bloom * (OneOverPreExposure * GlobalExposure * VignetteMask);
...
<span class="hl"><span class="ty">half3</span> OutDeviceColor = <span class="fn">ColorLookupTable</span>(FinalLinearColor);</span></div>

<p style="color:var(--text2);line-height:1.85;">
변수 이름이 흐름을 그대로 말한다. <code>FinalLinearColor</code>가 들어가고 <code>OutDeviceColor</code>가 나온다. 이 한 줄이 06장 그림의 마지막 경계다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그런데 여기서 문제가 하나 생긴다. 3D LUT의 격자는 0~1 범위의 좌표를 쓰는데, 입력은 HDR이라 1을 한참 넘는다. 격자를 linear 값에 그대로 대응시키면 1 이상의 값을 담을 수 없고, 담을 수 있게 범위를 늘리면 어두운 영역에 격자가 거의 안 남는다. <strong>02장에서 8bit 저장에 부딪혔던 문제가 격자 배분 문제로 다시 나타난 것이다.</strong> 해결책도 같다. 좌표를 비선형으로 배분한다. 이 역할을 하는 함수를 shaper라고 부른다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Engine/Shaders/Private/PostProcessTonemap.usf (UE 5.8)</span><span class="cm">// LUT를 읽기 전에 좌표를 shaper로 인코딩한다. LUT를 구울 때와 정확히 대칭이다</span>
<span class="kw">if</span> (LUTShaper) { LUTEncodedColor = <span class="fn">LinearToST2084</span>(<span class="fn">clamp</span>(LinearColor * LinearToNitsScale, <span class="num">0.0</span>, <span class="num">10000.0</span>)); }
<span class="kw">else</span>          { LUTEncodedColor = <span class="fn">LinToLog</span>( LinearColor + <span class="fn">LogToLin</span>( <span class="num">0</span> ) ); }
<span class="ty">float3</span> UVW = LUTEncodedColor * LUTScale + LUTOffset;
<span class="kw">return</span> <span class="fn">Texture3DSample</span>(...).rgb * LUTMax;</div>

<p style="color:var(--text2);line-height:1.85;">
shaper는 두 가지다. 로그 곡선이거나, PQ<span class="fn-note"><input type="checkbox" id="fn-pq" class="fn-toggle"><label for="fn-pq" class="fn-ref">14</label><span class="fn-body"><strong>PQ / ST 2084(Perceptual Quantizer):</strong> HDR 디스플레이용 전달 함수. sRGB 곡선이 0~1의 상대 밝기를 다루는 데 반해, PQ는 절대 밝기를 니트(nit, cd/m²) 단위로 다루며 최대 10000니트까지 표현한다. sRGB보다 훨씬 넓은 범위를 사람의 지각에 맞게 배분하도록 설계되어서, 넓은 범위를 균등한 격자에 담아야 하는 LUT 좌표용으로도 쓰인다.</span></span> 곡선이다. PQ를 쓰는 이유가 <code>TonemapCommon.ush</code>의 상수 주석에 적혀 있다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Engine/Shaders/Private/TonemapCommon.ush (UE 5.8)</span><span class="kw">static</span> <span class="kw">const</span> <span class="kw">float</span> LinearToNitsScale = <span class="num">100.0</span>;
<span class="cm">// A scale factor of 100 conveniently places about half of the PQ lut indexing below 1.0 ...</span>
<span class="cm">// Also, 100nits is the expected monitor brightness for a 1.0 pixel value without a tone curve.</span></div>

<p style="color:var(--text2);line-height:1.85;">
격자의 절반을 1.0 이하에 배정하고 나머지 절반을 1.0 초과 영역에 쓴다는 뜻이다. 02장에서 sRGB가 8bit 칸을 어두운 쪽에 몰아준 것과 같은 발상이다. <strong>정밀도가 유한할 때는 그것을 어디에 쓸지 정하는 문제가 반드시 따라온다.</strong> 이 글에서 여러 번 강조하는 이유가 여기에서도 드러난다.
</p>

<p style="color:var(--text2);line-height:1.85;">
LUT를 굽는 쪽으로 가면 톤커브와 인코딩이 한자리에 모여 있다. <code>PostProcessCombineLUTs.usf</code>가 격자점마다 하는 일의 순서가 이렇다.
</p>

<div class="flow-row">
<div class="flow-step"><div class="step-num">1</div><div class="step-name">shaper 디코드</div><div class="step-desc">균등 격자 좌표를 linear 값으로 되돌린다. 톤매퍼 쪽 인코딩과 대칭</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">2</div><div class="step-name">화이트밸런스</div><div class="step-desc"><code>WorkingColorSpace.ToXYZ</code>·<code>FromXYZ</code>로 색온도 보정. 11장의 행렬이 여기 쓰인다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">3</div><div class="step-name">AP1로 이동</div><div class="step-desc">그레이딩과 톤커브는 ACES의 넓은 색공간 AP1에서 계산한다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step hot"><div class="step-num">4</div><div class="step-name">톤커브</div><div class="step-desc"><code>FilmToneMap</code> 또는 ACES 출력 변환. 범위 압축이 여기서 일어난다</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step"><div class="step-num">5</div><div class="step-name">출력 색공간</div><div class="step-desc">AP1에서 sRGB·P3·Rec2020 등 목표 색공간으로 3x3 행렬</div></div>
<div class="flow-arrow">→</div>
<div class="flow-step hot"><div class="step-num">6</div><div class="step-name">디스플레이 인코딩</div><div class="step-desc"><code>LinearToSrgb</code>·<code>LinearTo709Branchless</code>·<code>LinearToST2084</code> 중 하나. 정밀도 배분이 여기</div></div>
</div>

<p style="color:var(--text2);line-height:1.85;">
4번과 6번이 04장 콜아웃에서 구분한 두 단계이고, 이 목록에서 확실히 갈라져 있다. 4번은 <code>FilmToneMap</code>이 담당하는데, 이 함수는 감마를 전혀 건드리지 않고 값의 범위만 S자 곡선으로 접는다. ACES<span class="fn-note"><input type="checkbox" id="fn-aces" class="fn-toggle"><label for="fn-aces" class="fn-ref">15</label><span class="fn-body"><strong>ACES(Academy Color Encoding System):</strong> 미국 영화예술과학아카데미가 만든 색 관리 표준. 촬영 장비와 상영 환경이 제각각인 상황에서 색을 일관되게 다루기 위해, 아주 넓은 색공간(AP0/AP1)을 작업 공간으로 두고 출력 장치마다 변환을 붙이는 구조다. UE 5.8은 ACES 2.0을 기본으로 쓴다.</span></span> 경로를 쓰면 그 자리를 표준 출력 변환이 대신한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
6번의 실제 분기가 파이프라인의 끝이다. 출력 장치가 무엇인지에 따라 다른 곡선이 붙는다.
</p>

<div class="data-table">
<table>
<tr><th>출력 장치</th><th>붙는 함수</th><th>의미</th></tr>
<tr><td>sRGB 모니터</td><td><code>LinearToSrgb()</code></td><td>02장의 그 곡선. 가장 흔한 경로</td></tr>
<tr><td>Rec.709</td><td><code>LinearTo709Branchless()</code></td><td>방송 규격 곡선. primaries는 sRGB와 같고 곡선만 다르다(05장)</td></tr>
<tr><td>HDR 디스플레이</td><td><code>LinearToST2084()</code></td><td>PQ. 입력이 니트 단위라는 점이 sRGB와 결정적으로 다르다</td></tr>
<tr><td>scRGB HDR</td><td>배율만 곱한다</td><td>인코딩 없이 linear를 그대로 보내는 방식</td></tr>
<tr><td>EXR 저장</td><td><code>LinearToST2084()</code> 후 되돌림</td><td>LUT를 거치기 위한 임시 인코딩이라 톤매퍼가 다시 디코드한다</td></tr>
<tr><td>NoToneCurve</td><td>없음</td><td>그레이딩만 하고 linear를 그대로 내보낸다</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
표의 함수 이름들은 <code>GammaCorrectionCommon.ush</code>에 모여 있고, 이 파일이 UE에서 전달 함수의 사전 역할을 한다. sRGB 인코딩만 해도 세 가지 구현이 있다.
</p>

<div class="code-block"><span class="code-lang">HLSL — Engine/Shaders/Private/GammaCorrectionCommon.ush (UE 5.8)</span><span class="cm">// 분기 없는 버전: min으로 두 부분을 합친다</span>
<span class="fn">LinearToSrgbBranchless</span>: <span class="fn">min</span>(lin * <span class="num">12.92</span>, <span class="fn">pow</span>(<span class="fn">max</span>(lin, <span class="num">0.00313067</span>), <span class="num">1</span>/<span class="num">2.4</span>) * <span class="num">1.055</span> - <span class="num">0.055</span>)

<span class="cm">// 분기 있는 버전: 02장의 공식 그대로</span>
<span class="fn">LinearToSrgbBranchingChannel</span>: lin &lt; <span class="num">0.00313067</span> ? lin * <span class="num">12.92</span> : <span class="fn">pow</span>(lin, <span class="num">1</span>/<span class="num">2.4</span>) * <span class="num">1.055</span> - <span class="num">0.055</span>

<span class="cm">// 실제로 쓰는 진입점. 플랫폼에 따라 위 둘 중 하나를 고른다</span>
<span class="cm">// "Branching is faster than branchless on AMD on PC"</span>
<span class="cm">// "Adreno devices(Nexus5) with Android 4.4.2 do not handle branching version well,</span>
<span class="cm">//  so always use branchless on Mobile"</span>
<span class="fn">LinearToSrgb</span>(...)</div>

<p style="color:var(--text2);line-height:1.85;">
공식의 상수가 02장의 그림과 정확히 일치한다. <code>12.92</code>, <code>1/2.4</code>, <code>1.055</code>, <code>0.055</code>. 문턱값이 규격의 <code>0.0031308</code>이 아니라 <code>0.00313067</code>인데, 두 부분이 정확히 이어지도록 다시 푼 값이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 백버퍼에 대해 한 가지 짚어 둘 것이 있다. <strong>백버퍼에는 <code>TexCreate_SRGB</code>가 붙지 않는다.</strong> 즉 하드웨어 sRGB 인코딩을 쓰지 않고, 셰이더가 이미 인코딩해 둔 값을 그대로 담는다. 스왑체인 쪽에는 별도로 색공간을 알려 주는데, 이것이 D3D12의 <code>DXGI_COLOR_SPACE</code> 설정이다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/D3D12RHI/Private/Windows/WindowsD3D12Viewport.cpp (UE 5.8)</span><span class="cm">// 스왑체인에 "이 버퍼의 값이 어떤 공간인지" 를 선언한다. 변환은 이미 셰이더가 했다</span>
SDR_sRGB / SDR_Rec709 → DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709
ST2084             → DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020
ScRGB              → DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709</div>

<p style="color:var(--text2);line-height:1.85;">
이름을 읽는 방법을 알면 유용하다. <code>G22</code>는 감마 2.2, <code>G2084</code>는 PQ, <code>G10</code>은 감마 1.0(즉 linear)이라는 뜻이고, <code>P709</code>와 <code>P2020</code>은 primaries다. 05장에서 말한 전달 함수와 색공간이 하나의 상수 이름에 나란히 들어 있는 셈이다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">11 — 색공간 관리</span>
</div>

# Working Color Space, 색공간을 다루는 시스템

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
05장에서 색공간이 선형성과 별개의 속성이라고 했다. UE5는 색공간을 다루는 시스템을 따로 두고 있으며, 이름이 Working Color Space다. 핵심 클래스는 <code>Core</code> 모듈에 있고 이름이 흔히 예상하는 <code>Math/ColorSpace.h</code>가 아니라 <code>ColorManagement/</code> 아래에 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 시스템의 설계에서 먼저 눈에 담을 것은 <strong>전달 함수와 색공간이 별개의 enum이라는 점</strong>이다. 05장의 결론이 자료 구조로 표현되어 있다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Core/Public/ColorManagement/ColorManagementDefines.h (UE 5.8)</span><span class="cm">// 전달 함수(선형성)를 나타내는 enum</span>
<span class="kw">enum</span> <span class="kw">class</span> EEncoding { None, Linear, sRGB, ST2084, Gamma22, BT1886, Gamma26, Cineon, ..., HLG };

<span class="cm">// 색공간(primaries)을 나타내는 enum. 위와 완전히 독립적이다</span>
<span class="kw">enum</span> <span class="kw">class</span> EColorSpace : <span class="ty">uint8</span> { None, sRGB, Rec2020, ACESAP0, ACESAP1, P3DCI, P3D65,
	REDWideGamut, SonySGamut3, ..., PLASA_E1_54, ACESCAM16, Max };

<span class="cm">// 흰색 기준점이 다를 때 쓰는 보정 방식</span>
<span class="kw">enum</span> <span class="kw">class</span> EChromaticAdaptationMethod { None, Bradford, CAT02 };
<span class="kw">inline</span> <span class="kw">constexpr</span> EChromaticAdaptationMethod DEFAULT_CHROMATIC_ADAPTATION_METHOD = EChromaticAdaptationMethod::Bradford;</div>

<p style="color:var(--text2);line-height:1.85;">
<code>FColorSpace</code> 클래스는 primaries 네 개(R, G, B, 흰색)를 <code>FVector2d</code>로 들고, RGB와 XYZ 사이의 변환 행렬을 double 정밀도로 캐시한다. 전역 하나가 프로젝트의 작업 색공간이고 <code>GetWorking()</code>으로 꺼낸다. 색공간 사이의 변환은 <code>FColorSpaceTransform</code>이 담당하며, 구현이 05장의 설명 그대로다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Core/Private/ColorManagement/ColorSpace.cpp (UE 5.8)</span><span class="cm">// 흰색 기준점이 같으면 두 행렬 곱으로 끝나고, 다르면 중간에 적응 행렬이 하나 끼어든다</span>
<span class="kw">return</span> Src.<span class="fn">GetRgbToXYZ</span>() * ChromaticAdaptationMat * Dst.<span class="fn">GetXYZToRgb</span>();</div>

<p style="color:var(--text2);line-height:1.85;">
프로젝트 설정에서 이 값을 바꾸는 곳은 <code>URendererSettings</code>의 WorkingColorSpace 카테고리이고, 프로퍼티에 <code>ConfigRestartRequired = true</code>가 붙어 있다. 에디터를 재시작해야 한다는 뜻이고, 그 이유가 코드 주석에 적혀 있다. <code>An editor restart is needed for the working color space shader compiler definitions</code>. 즉 이 설정은 <strong>셰이더 컴파일 정의로 내려간다.</strong>
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/RenderCore/Private/ShaderCompiler/ShaderCompiler.cpp (UE 5.8)</span><span class="cm">// sRGB 색공간이면 행렬 define을 아예 내보내지 않는다. 상수 경로로 컴파일된다</span>
<span class="kw">const</span> <span class="kw">bool</span> bWorkingColorSpaceIsSRGB = FColorSpace::<span class="fn">GetWorking</span>().<span class="fn">IsSRGB</span>();
<span class="fn">SET_SHADER_DEFINE</span>(Input.Environment, WORKING_COLOR_SPACE_IS_SRGB, ...);
<span class="kw">if</span> (!bWorkingColorSpaceIsSRGB) {
	<span class="cm">// WORKING_COLOR_SPACE_RGB_TO_XYZ_MAT, XYZ_TO_RGB_WORKING_COLOR_SPACE_MAT, SRGB_TO_WORKING_COLOR_SPACE_MAT</span>
	<span class="cm">// "Note that we transpose the matrices during print since color matrices are usually pre-multiplied."</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 설계가 실무에 주는 의미는 명확하다. <strong>프로젝트가 기본값인 sRGB 색공간을 쓰는 동안 이 시스템은 비용이 0이다.</strong> 행렬 곱이 셰이더에 아예 들어가지 않는다. 그리고 색공간을 바꾸면 셰이더와 텍스처가 전부 다시 빌드된다. 어떻게 무효화되는지도 코드에 있다. 셰이더 맵 키에 primaries 좌표의 해시가 들어가고, 텍스처 DDC<span class="fn-note"><input type="checkbox" id="fn-ddc" class="fn-toggle"><label for="fn-ddc" class="fn-ref">16</label><span class="fn-body"><strong>DDC(Derived Data Cache):</strong> 에셋 원본에서 가공한 결과물(압축된 텍스처, 컴파일된 셰이더 등)을 캐시해 두는 저장소. 캐시 키는 원본과 모든 빌드 설정에서 만들어지므로, 설정이 바뀌면 키가 달라져 자동으로 다시 빌드된다. 작업 색공간이 텍스처 인코딩에 영향을 주므로 그 좌표도 키에 들어간다.</span></span> 키에도 같은 값이 섞인다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Private/TextureDerivedDataBuildUtils.cpp (UE 5.8)</span><span class="cm">// The texture color transform depends on the chromaticities of both the source color space</span>
<span class="cm">// and the destination (working) color space, per its project setting. We therefore include</span>
<span class="cm">// the working color space chromaticities to incur a texture rebuild if/when changed.</span></div>

<p style="color:var(--text2);line-height:1.85;">
셰이더에서 쓸 때는 두 경로가 있다. 머티리얼과 일반 셰이더는 위의 컴파일 타임 define을 쓰고, 톤매퍼 계열은 런타임 유니폼 버퍼를 쓴다. 후자에는 자주 쓰는 변환이 미리 들어 있다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Public/SceneManagement.h (UE 5.8)</span><span class="fn">BEGIN_GLOBAL_SHADER_PARAMETER_STRUCT</span>(FWorkingColorSpaceShaderParameters, ENGINE_API)
	<span class="fn">SHADER_PARAMETER</span>(FMatrix44f, ToXYZ) FromXYZ ToAP1 FromAP1 ToAP0 FromAP0
	<span class="fn">SHADER_PARAMETER</span>(<span class="ty">uint32</span>, bIsSRGB)
<span class="fn">END_SHADER_PARAMETER_STRUCT</span>()</div>

<p style="color:var(--text2);line-height:1.85;">
<code>ToAP1</code>과 <code>FromAP1</code>이 있는 이유가 10장의 흐름 3번과 5번이다. 그레이딩과 톤커브를 ACES의 AP1 색공간에서 하려면 작업 색공간에서 AP1로 갔다 와야 하고, 그 행렬을 매 프레임 다시 계산하지 않도록 유니폼 버퍼에 담아 둔 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
휘도 계산도 이 시스템을 타게 바뀌었다. 흑백으로 바꿀 때 쓰는 RGB 가중치가 색공간에 따라 달라지기 때문이다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Core/Private/Math/Color.cpp (UE 5.8)</span><span class="kw">float</span> FLinearColor::<span class="fn">GetLuminance</span>() <span class="kw">const</span>
{
	<span class="kw">static</span> <span class="kw">const</span> IConsoleVariable* CVar = IConsoleManager::<span class="fn">Get</span>().<span class="fn">FindConsoleVariable</span>(<span class="str">"r.LegacyLuminanceFactors"</span>);
	<span class="kw">static</span> <span class="kw">const</span> FLinearColor LuminanceFactors = CVar-&gt;<span class="fn">GetInt</span>() != <span class="num">0</span>
		? <span class="fn">FLinearColor</span>(<span class="num">0.3f</span>, <span class="num">0.59f</span>, <span class="num">0.11f</span>)                        <span class="cm">// 레거시: NTSC 계수</span>
		: UE::Color::FColorSpace::<span class="fn">GetWorking</span>().<span class="fn">GetLuminanceFactors</span>();  <span class="cm">// 색공간에서 파생</span>
	<span class="kw">return</span> R*LuminanceFactors.R + G*LuminanceFactors.G + B*LuminanceFactors.B;
}</div>

<p style="color:var(--text2);line-height:1.85;">
계수가 하드코딩이 아니라 <strong>RGB에서 XYZ로 가는 행렬의 두 번째 열</strong>에서 나온다. XYZ의 Y가 정의상 휘도이므로, 그 열이 곧 "각 원색이 밝기에 얼마나 기여하는가"다. sRGB 색공간에서 이 값은 <code>(0.212639, 0.715169, 0.072192)</code>이며 흔히 Rec.709 계수라고 부르는 그 숫자다. 그리고 이 함수가 <code>FLinearColor</code>의 멤버라는 사실을 눈여겨보자. <strong>휘도 계산은 linear에서만 의미가 있으므로 <code>FColor</code>에는 이 함수가 없다.</strong> 08장에서 본 두 타입의 분리가 어떤 함수를 어느 타입에 둘지까지 정하고 있는 것이다.
</p>

<div class="callout callout-info">
<div class="callout-title">색공간까지 신경 써야 하는 경우</div>
<p>대부분의 게임 프로젝트는 기본값인 sRGB 색공간을 그대로 쓰고, 그러면 이 장의 내용은 전부 no-op이다. 실제로 색공간이 문제가 되는 상황은 셋이다. <strong>영상 소재를 들여올 때</strong>(카메라마다 색공간이 다르므로 <code>FTextureSourceColorSettings</code>로 원본 색공간을 지정해야 한다), <strong>HDR 디스플레이로 출력할 때</strong>(Rec.2020 같은 넓은 색공간을 실제로 쓰게 된다), 그리고 <strong>영화 파이프라인과 색을 맞춰야 할 때</strong>(ACES 색공간을 작업 공간으로 쓰는 경우)다. 앞의 두 경우가 아니라면 05장의 구분만 알고 넘어가도 코드를 쓰는 데 문제가 없다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">12 — 실무</span>
</div>

# 어디까지 알면 실수하지 않는가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
마지막 장은 앞의 내용을 판단 기준으로 바꾼 것이다. linear와 sRGB가 섞이는 코드를 쓸 때 확인할 것은 결국 하나다. <strong>"지금 이 값은 어느 공간에 있고, 여기서 내가 하려는 연산은 어느 공간을 요구하는가."</strong> 자주 마주치는 상황별로 정리한다.
</p>

<div class="step-block s1">
<h4>텍스처를 임포트할 때</h4>
<p>기준은 하나다. <strong>이 텍스처의 값이 "사람이 보는 밝기"인가.</strong> 그렇다면 sRGB를 켠다. albedo, 이모시브 컬러, UI 아이콘, 스카이 텍스처가 여기 해당한다. 값이 밝기가 아니라 다른 물리량이나 스위치라면 끈다. 노멀맵(방향 벡터), roughness와 metallic(재질 계수), AO와 마스크(0~1 비율), 하이트맵(높이), 플로우맵(속도)이 그렇다. 07장에서 본 대로 엔진이 강제로 꺼 주는 세팅은 <code>TC_Alpha</code>·<code>TC_Normalmap</code>·<code>TC_Masks</code>·HDR 계열 넷뿐이라, 그 밖에서는 직접 판단해야 한다. 여러 마스크를 채널에 몰아 넣은 텍스처는 <code>TC_Masks</code>를 쓰는 것이 가장 안전하다. 압축 방식은 <code>TC_Default</code>와 같으면서 sRGB만 확실히 꺼지기 때문이다.</p>
</div>

<div class="step-block s2">
<h4>C++에서 색을 다룰 때</h4>
<p><strong>계산할 값은 무조건 <code>FLinearColor</code>로 들고 다닌다.</strong> <code>FColor</code>는 저장과 전송 포맷으로만 쓴다. 변환은 방향에 따라 함수가 정해져 있다. 인코딩된 8bit에서 계산용으로 올 때는 <code>FLinearColor(FColor)</code> 또는 <code>FromSRGBColor()</code>, 반대로 내려갈 때는 <code>ToFColor(true)</code>다. <code>FColor(FLinearColor)</code>를 쓰려다 링크 에러가 나면 그것이 의도된 안전장치이니 캐스팅으로 우회하지 말고 <code>ToFColor(true)</code>를 쓴다. 다만 이미 linear인 8bit 데이터, 특히 <strong>vertex color</strong>를 다룰 때는 <code>ReinterpretAsLinear()</code>가 맞다. GPU가 그렇게 읽기 때문이다(08장). 셰이더에 상수 색을 넘길 때는 언제나 <code>FLinearColor</code>이고, 디자이너에게 받은 헥스 코드는 sRGB 공간이므로 먼저 디코드해야 한다.</p>
</div>

<div class="step-block s3">
<h4>렌더타깃을 만들고 읽을 때</h4>
<p>여기가 함정이 가장 많은 자리다. 우선 포맷과 sRGB 여부가 얽혀 있다. <code>RTF_RGBA8</code>과 <code>RTF_RGBA8_SRGB</code>는 픽셀 포맷이 똑같이 <code>PF_B8G8R8A8</code>이고 차이는 <code>TexCreate_SRGB</code>뿐이므로, <strong>포맷만 봐서는 구분할 수 없다.</strong> 판단은 <code>IsSRGB()</code>가 하는데 그 구현에 엔진 자신의 주석이 붙어 있을 정도로 상태가 갈라져 있다.</p>
</div>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Private/TextureRenderTarget2D.cpp (UE 5.8)</span><span class="kw">bool</span> UTextureRenderTarget2D::<span class="fn">IsSRGB</span>() <span class="kw">const</span> {
	<span class="cm">// in theory you'd like the "bool SRGB" variable to == this, but it does not</span>
	<span class="cm">// ?? note: UTextureRenderTarget::TargetGamma is ignored here</span>
	<span class="cm">// ?? note: GetDisplayGamma forces linear for some float formats, but this doesn't</span>
	<span class="kw">if</span> (OverrideFormat == PF_Unknown) <span class="kw">return</span> RenderTargetFormat == RTF_RGBA8_SRGB;
	<span class="kw">else</span> <span class="kw">return</span> !bForceLinearGamma;
}</div>

<p style="color:var(--text2);line-height:1.85;">
그리고 읽는 API가 인코딩 상태를 바꾼다는 사실을 반드시 알아야 한다. <code>ReadRenderTargetPixel</code>은 포맷에 따라 다르게 동작한다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Private/KismetRenderingLibrary.cpp (UE 5.8)</span><span class="kw">case</span> PF_B8G8R8A8:  <span class="kw">return</span> Samples[<span class="num">0</span>];                          <span class="cm">// 이미 인코딩된 바이트를 그대로</span>
<span class="kw">case</span> PF_FloatRGBA:
<span class="kw">case</span> PF_A32B32G32R32F: <span class="kw">return</span> LinearSamples[<span class="num">0</span>].<span class="fn">ToFColor</span>(<span class="kw">true</span>);   <span class="cm">// linear를 sRGB로 인코딩해서 반환</span></div>

<p style="color:var(--text2);line-height:1.85;">
즉 FP16 렌더타깃에 linear 값을 써 놓고 이 함수로 읽으면 <strong>sRGB로 인코딩된 값이 돌아온다.</strong> 쓴 값과 읽은 값이 다른 것이 버그가 아니라 명세다. 원래 값이 필요하면 <code>ReadRenderTargetRawPixel</code>을 써야 한다. 같은 규칙이 <code>ReadPixels</code> 전반에 적용되고, 헤더 주석에도 그렇게 명시되어 있다. <code>If the RenderTarget surface is float linear, it will converted to SRGB FColor, if InFlags.bLinearToGamma is set (which is on by default).</code>
</p>

<div class="step-block s4">
<h4>UI 색이 이상할 때</h4>
<p>Slate와 UMG는 <strong>입력이 언제나 linear라고 가정하고, 셰이더가 직접 인코딩한다.</strong> 이 가정은 런타임 토글이 아니라 셰이더 상수로 못 박혀 있다. <code>SlateShaderCommon.ush</code>에 <code>#define SOURCE_IN_LINEAR_SPACE 1</code>이 하드코딩되어 있고 C++ 쪽 정의가 아예 없다. 따라서 <code>FSlateBrush::TintColor</code>나 <code>SetColorAndOpacity</code>에 넣는 값은 <code>FLinearColor</code>여야 한다. 여기에 sRGB 공간의 값을 그대로 넣으면 <strong>색이 실제보다 밝고 뿌옇게</strong> 나온다. 인코딩된 값을 linear로 취급했으니 02장의 계산대로 128이 0.5로 읽혀 실제보다 2.3배 밝아지는 것이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
반대 방향의 증상도 있다. 이미 톤매퍼가 인코딩해 둔 결과 위에 Slate가 감마를 한 번 더 적용하면 <strong>화면이 씻긴 것처럼 밝고 대비가 낮아진다.</strong> 이 이중 적용을 막는 장치가 <code>ESlateDrawEffect::NoGamma</code>이고, 씬 뷰포트가 실제로 그것을 쓴다. 그래서 UI 색 문제를 진단할 때는 순서가 있다.
</p>

<div class="data-table">
<table>
<tr><th>증상</th><th>가장 흔한 원인</th><th>확인할 곳</th></tr>
<tr><td>UI 색이 지정한 것보다 밝고 뿌옇다</td><td>sRGB 값을 linear 자리에 넣었다</td><td>색을 만드는 코드에 <code>ReinterpretAsLinear</code>나 <code>/255</code>가 있는지</td></tr>
<tr><td>UI 색이 지정한 것보다 어둡다</td><td>linear 값을 인코딩된 자리에 넣었다</td><td><code>ToFColor(true)</code>를 빠뜨렸는지</td></tr>
<tr><td>씬 위에 그린 것만 씻긴 듯 밝다</td><td>감마가 두 번 적용됐다</td><td><code>NoGamma</code> 드로우 이펙트, <code>bAllowGammaCorrection</code></td></tr>
<tr><td>모바일에서만 색이 다르다</td><td>R8 sRGB 샘플링을 셰이더가 근사한다</td><td><code>ProcessMaterialGreyscaleTextureLookup</code>의 <code>// sRGB read approximation</code></td></tr>
<tr><td>멀리 있는 물체가 어둡다</td><td>밉맵이 잘못된 공간에서 평균됐다</td><td>텍스처의 sRGB 플래그, 런타임 밉 생성 경로</td></tr>
<tr><td>두 광원이 겹친 곳만 하얗게 탄다</td><td>인코딩된 값을 더했다</td><td>03장의 계산. 커스텀 라이팅 코드의 입력 공간</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
마지막으로 포스트 프로세스 머티리얼을 쓸 때의 함정이 하나 남았다. 블렌더블 위치에 따라 입력의 인코딩 상태가 다르고, <strong>그중 하나만 예외</strong>다.
</p>

<div class="code-block"><span class="code-lang">C++ — Runtime/Engine/Classes/Engine/BlendableInterface.h (UE 5.8)</span><span class="cm">// 대부분의 위치는 이렇게 적혀 있다</span>
BL_SceneColorBeforeDOF, BL_SceneColorAfterDOF, BL_SSRInput, BL_SceneColorBeforeBloom
<span class="cm">//   → "Inputs and output always in linear color space."</span>

<span class="cm">// 그런데 이 하나만 다르고, 하필 enum 값이 0이다</span>
BL_SceneColorAfterTonemapping = <span class="num">0</span>
<span class="cm">//   → "Inputs and output in different color spaces, based rendering settings</span>
<span class="cm">//      for instance (sRGB/Rec709, HDR or even Linear Color)."</span></div>

<p style="color:var(--text2);line-height:1.85;">
톤매핑 이후 위치의 입력은 이미 인코딩된 값이고, 게다가 어떤 인코딩인지가 출력 장치 설정에 따라 달라진다. 즉 <strong>이 위치에서는 색을 더하거나 곱하는 연산이 물리적으로 옳지 않다.</strong> 그리고 이 항목이 enum 값 0이라서 초기화를 빼먹으면 기본으로 여기가 선택된다. 포스트 프로세스 머티리얼에서 색 연산이 이상하게 나오면 블렌더블 위치를 먼저 확인하는 것이 빠르다.
</p>

<div class="callout callout-gold">
<div class="callout-title">여기까지 알면 충분하다</div>
<p>linear와 sRGB를 다루는 코드를 쓰는 데 필요한 지식은 결국 네 줄로 압축된다. <strong>하나,</strong> 텍스처가 밝기를 담는지 아닌지로 sRGB 플래그를 정한다. <strong>둘,</strong> 계산은 <code>FLinearColor</code>와 float 버퍼에서만 하고 8bit 타입은 저장용으로만 쓴다. <strong>셋,</strong> 경계를 넘는 방식이 세 가지(하드웨어 샘플러, C++ 변환 함수, 셰이더 코드)이므로 지금 어느 방식인지를 확인한다. <strong>넷,</strong> 렌더타깃에 쓰거나 읽을 때는 그 API가 인코딩 상태를 바꾸는지 문서를 확인한다. 나머지는 이 네 줄에서 파생되는 사례들이다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">정리</span>
</div>

# 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
한 문장으로 압축하면 이렇다. <strong>sRGB 인코딩은 비트가 부족할 때 사람 눈이 민감한 어두운 영역에 정밀도를 몰아주는 압축 기법이고, 빛을 더하고 곱하고 평균내는 모든 연산은 그 곡선을 벗겨낸 linear 공간에서만 물리적으로 옳다. 그래서 렌더링 파이프라인은 입력에서 디코드하고 출력에서 인코딩하며, HDR 렌더링은 그 사이 구간의 값 범위 상한을 없앤 것이다.</strong> 언리얼엔진에서 이 구조는 <code>UTexture::SRGB</code> 한 비트가 <code>TexCreate_SRGB</code>를 거쳐 <code>DXGI_FORMAT_BC1_UNORM_SRGB</code>가 되는 체인, <code>FColor</code>와 <code>FLinearColor</code>를 별개 타입으로 갈라 놓고 암묵적 변환을 링크 에러로 막은 설계, <code>PF_FloatRGBA</code> scene color에 <code>PreExposure</code>를 곱해 담는 관례, 그리고 톤커브와 디스플레이 인코딩을 3D LUT 하나에 구워 넣은 출력 경로로 구현되어 있다.
</p>

<div class="card-grid">
<div class="card blue">
<div class="card-label">128 vs 188</div>
<div class="card-title">중간값은 절반이 아니다</div>
<div class="card-desc">저장값 128은 흰색 밝기의 21.6%이고, 절반인 linear 0.5를 담으려면 188을 써야 한다. 이 두 숫자를 알면 "묘하게 어둡다"와 "묘하게 밝다"의 진단이 절반은 끝난다.</div>
</div>
<div class="card teal">
<div class="card-label">더하기가 기준</div>
<div class="card-title">빛은 더해진다</div>
<div class="card-desc">조명 합산·알파 블렌딩·텍스처 필터링·밉맵 생성이 전부 더하기와 평균이다. 흑백 체커보드 밉맵을 sRGB에서 평균내면 2.34배 어두워지는 것이 이 규칙을 어긴 대가다.</div>
</div>
<div class="card gold">
<div class="card-label">항등 함수</div>
<div class="card-title">변환은 하드웨어가 한다</div>
<div class="card-desc"><code>ProcessMaterialColorTextureLookup</code>과 <code>EncodeBaseColor</code>는 몸통이 <code>return</code> 한 줄이다. 실제 일은 포맷의 <code>_SRGB</code> 접미사가 하고, 셰이더는 언제나 linear를 본다. 그래서 플래그를 틀리면 컴파일 에러 없이 값만 조용히 틀린다.</div>
</div>
<div class="card purple">
<div class="card-label">두 개의 속성</div>
<div class="card-title">선형성과 색공간은 다르다</div>
<div class="card-desc">sRGB와 Rec.709는 primaries가 같고 곡선만 다르다. UE의 <code>EEncoding</code>과 <code>EColorSpace</code>가 별개 enum인 것이 이 사실의 표현이고, 색공간 변환은 반드시 linear 상태에서만 유효하다는 것이 <code>check()</code>로 강제되어 있다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
핵심 숫자들만 모아 두자. sRGB 인코딩 상수 <code>12.92</code> · <code>0.0031308</code> · <code>1.055</code> · <code>1/2.4</code>, 저장값 128의 linear 값 0.2159, linear 0.5의 저장값 188, sRGB 8bit의 가장 어두운 쪽 간격 0.000304(linear 8bit보다 약 13배 촘촘), 같은 8bit 안에서 밝은 쪽과 어두운 쪽 간격 차이 약 29배, 체커보드 밉맵 오차 2.34배, FP16의 표현 범위 약 30스톱(EV −14에서 +16), scene color 기본 포맷 <code>PF_FloatRGBA</code>, LUT 기본 크기 32칸, PQ shaper의 스케일 100니트, sRGB 색공간의 휘도 계수 <code>(0.212639, 0.715169, 0.072192)</code>.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 글의 내용을 알고 다른 글들을 다시 읽으면 보이는 것이 달라진다. <a href="/brdf">BRDF</a>가 반환하는 값과 <a href="/monte-carlo">몬테카를로 적분</a>이 평균내는 값은 전부 linear radiance다. 즉 03장의 규칙은 그 두 글의 모든 수식에 처음부터 전제되어 있었다. <a href="/sky-light">Sky Light</a>와 <a href="/reflection-capture">Reflection Capture</a>가 큐브맵을 프리필터할 때 하는 일도 결국 linear에서의 가중 평균이다. <a href="/taa">TAA</a>와 <a href="/tsr">TSR</a>이 프레임을 누적하는 것, <a href="/denoising">디노이저</a>가 이웃 픽셀을 섞는 것도 같은 규칙을 따른다. linear인지 sRGB인지는 별도의 기능이 아니라 <strong>렌더러의 모든 연산이 공통으로 전제하는 조건</strong>이고, 그래서 이 전제가 어긋나면 어느 기능이 틀렸는지 짚어내기 어려운 형태로 화면이 이상해진다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card blue">
<div class="card-label">규격과 이론</div>
<div class="card-title">전달 함수와 색공간</div>
<div class="card-desc">IEC 61966-2-1 (sRGB), ITU-R BT.709 · BT.2020 · BT.2100 (Rec.709 / Rec.2020 / PQ와 HLG), SMPTE ST 2084 (PQ), SMPTE RP 177 (primaries에서 RGB·XYZ 행렬을 유도하는 절차), <a href="https://docs.acescentral.com/">ACES 문서</a>, <a href="https://www.color.org/chardata/rgb/srgb.xalter">ICC의 sRGB 자료</a>. Charles Poynton, <a href="https://poynton.ca/GammaFAQ.html">"Gamma FAQ"</a> · <a href="https://poynton.ca/ColorFAQ.html">"Color FAQ"</a>는 이 주제의 고전 입문서다.</div>
</div>
<div class="card teal">
<div class="card-label">실무 문헌</div>
<div class="card-title">선형 워크플로</div>
<div class="card-desc">Larry Gritz &amp; Eugene d'Eon, "The Importance of Being Linear" (GPU Gems 3, ch.24) 는 이 글 03장의 원조 격 문헌이다. <a href="https://pbr-book.org/4ed/Color_and_Radiometry">PBRT 4th ed. ch.4 "Radiometry, Spectra, and Color"</a>; John Hable, <a href="https://filmicworlds.com/blog/filmic-tonemapping-operators/">"Filmic Tonemapping Operators"</a>; <a href="https://gist.github.com/rygorous/2203834">Fabian Giesen, "linear to sRGB uint8 conversion"</a>(UE의 <code>ToFColorSRGB</code> 구현의 출처).</div>
</div>
<div class="card gold">
<div class="card-label">엔진 소스</div>
<div class="card-title">언리얼엔진 5.8</div>
<div class="card-desc"><code>Math/Color.h</code> · <code>Color.cpp</code>, <code>ColorManagement/ColorSpace.h</code> · <code>ColorManagementDefines.h</code>, <code>Engine/Texture.h</code> · <code>Texture.cpp</code>, <code>TextureImportSettings.cpp</code>, <code>StreamableTextureResource.cpp</code>, <code>DXGIUtilities.h</code>, <code>RHIResources.h</code> · <code>RHIResources.cpp</code>, <code>D3D12Texture.cpp</code> · <code>D3D12PipelineState.cpp</code> · <code>D3D12Viewport.cpp</code>, <code>LightRendering.cpp</code>, <code>GenerateMips.cpp</code>, <code>SlateRHIRenderingPolicy.cpp</code>, <code>SceneTexturesConfig.cpp</code>, <code>GBufferInfo.cpp</code>, <code>TextureRenderTarget2D.cpp</code>, <code>KismetRenderingLibrary.cpp</code>, <code>TextureCompressorModule.cpp</code>, <code>MaterialTexture.ush</code>, <code>DeferredShadingCommon.ush</code>, <code>GammaCorrectionCommon.ush</code>, <code>TonemapCommon.ush</code>, <code>PostProcessTonemap.usf</code>, <code>PostProcessCombineLUTs.usf</code>, <code>ColorSpace.ush</code>, <code>SlateElementPixelShader.usf</code>, <code>CompositeUIPixelShader.usf</code>, <code>ComputeGenerateMips.usf</code>. 이 글의 모든 코드 인용의 1차 출처.</div>
</div>
<div class="card purple">
<div class="card-label">이 블로그</div>
<div class="card-title">이어 읽기</div>
<div class="card-desc">이 글이 바닥을 깐 글들: <a href="/brdf">BRDF</a>(linear radiance를 다루는 함수), <a href="/monte-carlo">몬테카를로 적분</a>(linear에서의 평균), <a href="/d8c73243c492ed7b5f44b70936cfe4521669ad34">렌더링 방정식</a>, <a href="/sky-light">Sky Light</a>·<a href="/reflection-capture">Reflection Capture</a>(큐브맵 프리필터), <a href="/gpu-lightmass">GPU Lightmass</a>(라이트맵의 인코딩), <a href="/taa">TAA</a>·<a href="/tsr">TSR</a>·<a href="/denoising">디노이징</a>(프레임 누적), <a href="/virtualtexture">Virtual Texture</a>(타일 포맷과 sRGB).</div>
</div>
</div>
</div>
