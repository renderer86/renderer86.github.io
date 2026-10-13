---
layout: post
title: "stat unit의 Input ms, 버튼에서 화면까지가 아니다: UE 5.8 소스로 확인한 입력 지연의 정체와 격투 게임이 한 프레임을 줄이는 방법"
icon: paper
permalink: input-latency
categories: Rendering
tags: [Rendering, UnrealEngine, InputLatency, Latency, FramePacing, VSync, DXGI, Reflex, FightingGame]
excerpt: "stat unit을 켜면 Frame, Game, Draw, GPU, RHIT 아래에 Input이라는 행이 하나 더 있고, 보통 30~60ms쯤 되는 큰 숫자가 찍힌다. 다들 이걸 '컨트롤러를 누르고 화면에 보이기까지'로 읽는데, 소스를 열어 보면 그렇지 않다. 이 값은 엔진이 그 프레임의 입력을 읽기 시작할 때 적어 둔 시간과, 그 프레임이 모니터에 표시되기 시작한 시간의 차이다. 컨트롤러의 USB 폴링도, 이벤트가 OS 큐에서 기다린 시간도, 모니터의 내부 처리도 이 숫자 밖에 있다. 이 글은 그 두 시간을 각각 어디서 적는지(엔진 루프의 PumpMessages 직전, DXGI의 WaitForVBlank 스레드), 프레임 번호와 Present 카운터를 어떻게 짝지어 두 시간을 같은 프레임에 묶는지, 화면에 보이는 값이 왜 원래 값이 아니라 평균인지를 UE 5.8 소스로 따라간다. 이어서 파이프라인이 지연을 만드는 구조(스레드 겹침, Present 큐, 백버퍼 3개)와 그것을 줄이는 콘솔 변수들의 대가를 정리하고, 마지막으로 격투 게임이 한 프레임을 줄이려고 무엇을 포기하는지를 본다."
back_color: "#ffffff"
img_name: "stat-unit-input-latency.webp"
toc: false
show: true
new: true
series: -1
index: 40
---

>
> **이런 분이 읽으면 좋습니다!**
>
> - `stat unit`의 Input 행이 정확히 무엇을 재는지, 그게 "버튼에서 화면까지"가 맞는지 확인하고 싶은 분
> - 그 값이 왜 어떤 빌드, 플랫폼에서는 아예 안 보이는지 궁금했던 분
> - 입력 지연을 줄이라는 요구를 받았는데 어디를 만져야 하고 그 대가가 뭔지 알고 싶은 분
> - `r.OneFrameThreadLag`, `r.GTSyncType`, `rhi.SyncSlackMS`를 각각 언제 쓰는지 헷갈리는 분
> - 격투 게임이 "3프레임"을 만들려고 무엇을 포기하는지 궁금한 분
>
> **이 글로 알 수 있는 내용**
>
> - Input 값의 정확한 정의: 입력을 읽을 때 적어 둔 시간과 화면에 표시되기 시작할 때 적어 둔 시간의 차이, 그리고 그 계산이 도는 스레드
> - 입력을 읽은 시간을 엔진 루프의 어디서 적는지, 그래서 왜 버튼을 누른 시점과 다른지
> - 화면에 표시되기 시작한 시간을 어디서 받아 오는지: `IDXGIOutput::WaitForVBlank` 전용 스레드와 `GetFrameStatistics`의 `SyncQPCTime`
> - 프레임 번호와 Present 카운터를 짝짓는 방식, 그리고 UE 5.7에서 5.8로 오며 이 부분을 새로 짠 이유
> - 화면에 보이는 값이 매 프레임 계산값과 어떻게 다른지: 직전 값 90%에 새 값 10%만 섞는 평균, 200프레임 Max, `stat raw`의 의미, 색이 바뀌는 기준값 2.5
> - 이 숫자에 빠져 있는 구간과, 버튼을 누른 순간부터 픽셀이 바뀔 때까지 실제로 걸리는 시간을 추정하는 방법
> - 엔진이 어떤 구조 때문에 지연을 만드는지, 그리고 지연을 줄이는 콘솔 변수를 켜면 무엇을 잃는지
> - 격투 게임이 입력 지연을 줄이려고 실제로 포기한 것들: 철권 7의 7.2프레임에서 철권 8의 2.4프레임까지, UE5 간판 기능을 뺀 선택, 개발자 발언
> - 같은 엔진인데 두 배 차이가 나는 이유, 그리고 프레임을 줄이는 방법들(120Hz, 가변 리프레시, VSync, 전용 옵션)의 측정된 효과
>
<br>

{% include research-post-style.html %}

<div class="research-post">
<span class="section-eyebrow">00. 개요</span>
</div>

<!--
  [요약] 왜 stat unit의 Input을 "입력 지연"으로 잘못 읽게 되는가

  오해가 생기는 이유
  - 행 이름이 Input이고, 값이 Game, GPU보다 서너 배 커서 프레임 시간 단위가 아니라 체감 지연 단위처럼 보인다.
  - 그래서 click-to-photon, 즉 버튼을 누른 순간부터 픽셀이 바뀌기까지로 해석하게 된다.

  실제로 재는 구간은 앞뒤가 잘려 있다
  - 시작점이 버튼이 아니다. 마커는 엔진 루프의 PumpMessages 바로 앞에서 찍힌다(02장).
    그 프레임이 처리하는 키보드, 마우스 이벤트는 이미 OS 큐에 와 있던 것이라 큐 대기 시간이 통째로 빠진다.
    평균 반 프레임, 60Hz 기준 약 8ms. 엔진 주석도 "Roughly track the time when the input was sampled"라고 한계를 적어 둔다.
  - XInput 패드는 반대 방향으로 어긋난다. 패드 상태 조회는 마커보다 뒤에서 일어나므로 그 차이도 값에 안 들어간다.
  - 끝점이 픽셀이 아니다. DXGI GetFrameStatistics의 VBlank 플립 시각(SyncQPCTime)을 쓴다(03장).
    모니터 내부 처리, 화면 상하 위치에 따른 스캔 시간, 패널 응답 속도는 전부 이 뒤에 있다.
  - 컨트롤러 안의 폴링 주기와 USB, 무선 전송 시간도 엔진 밖이다(05장 표).

  그래서 무엇을 재는 값인가
  - 입력을 읽기 시작한 시점부터 화면에 표시되기 시작한 시점까지. 엔진 코드로 손댈 수 있는 구간과 정확히 겹친다.
  - 파이프라인 깊이(Input ÷ Frame)를 재는 도구로는 맞지만, "우리 게임 입력 지연은 40ms"라고 스펙에 적으면 실제보다 작은 숫자가 된다.
  - 화면에 찍히는 값은 직전 값 90%에 새 값 10%를 섞은 평균이라 원래 값도 아니다(04장).
-->

# 그 숫자를 처음 봤을 때 하는 오해

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
<code>stat unit</code>을 켜면 익숙한 다섯 줄이 나온다. Frame, Game, Draw, GPU, RHIT다. 차례로 한 프레임 전체, 게임 스레드, 렌더 스레드, GPU, RHI 스레드가 쓴 시간이다. 그런데 그 아래에 Input이라는 행이 하나 더 나온다. 거기 찍히는 숫자는 다른 행들과 자릿수가 다르다. Game이 8ms, GPU가 11ms인데 Input은 40ms 같은 값이 나온다. 프레임 시간의 두세 배다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그러면 자연스럽게 이렇게 읽는다. <strong>"컨트롤러를 눌러서 화면에 보이기까지 40ms"</strong>. 숫자 크기도 그럴듯하고 이름도 Input이니까. 이 해석은 절반만 맞다. 무엇을 재는지는 맞게 짚었는데, <strong>실제로 재는 구간이 앞뒤로 짧다.</strong> 재기 시작하는 쪽은 버튼을 누른 순간이 아니라 엔진이 그 프레임의 입력을 읽기 시작한 순간이다. 재기를 멈추는 쪽도 픽셀 색이 실제로 바뀐 순간이 아니라 그 프레임이 모니터에 표시되기 시작한 순간이다. 앞뒤로 빠진 구간이 각각 따로 있다는 뜻이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 이 값을 어디에 쓰느냐에 따라 결과가 갈린다. 격투 게임처럼 지연이 곧 게임성인 장르에서 "우리 게임 입력 지연은 40ms입니다"라고 적으면, 빠진 구간만큼 실제보다 낮게 적는 셈이 된다. 반대로 최적화 작업에서는 이 값이 요긴하다. 이 글에서 파이프라인이라고 부르는 것은 입력 하나가 게임 스레드, 렌더 스레드, RHI 스레드, GPU, 모니터를 차례로 거쳐 가는 단계들이다. Input을 같은 화면의 Frame으로 나누면 이 파이프라인이 몇 프레임 깊은지 바로 나온다. Frame이 16.67ms인데 Input이 40ms면 40 ÷ 16.67로 약 2.4다. 입력 하나가 화면에 닿기까지 프레임 2.4개를 거친다는 뜻이고, 그만큼 단계가 겹쳐 쌓여 있다는 신호다. 엔진 안에서 이걸 알려 주는 값은 Input뿐이다. 이 비율을 실제로 읽는 방법은 10장에서 다룬다. <strong>어디부터 어디까지 재는 값인지 알고 쓰면 쓸 만한 도구다. 모르고 쓰면 실제보다 작은 숫자를 우리 게임의 입력 지연이라고 잘못 내놓게 된다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
이 글은 세 부분으로 나뉜다. 앞부분(01~05장)은 소스를 따라가며 이 값이 정확히 무엇인지 확인한다. 두 번째(06~08장)는 이 값이 왜 안 보이는 경우가 있는지, 엔진이 어떤 구조 때문에 지연을 만드는지, 그리고 그 지연을 줄이는 콘솔 변수를 켜면 무엇을 잃는지 정리한다. 마지막(09~11장)은 이 값을 실무에서 쓰는 절차를 다루고, 격투 게임이 한 프레임을 줄이려고 무엇을 포기하는지 본다.
</p>

<div class="callout callout-info">
<div class="callout-title">이 글의 출처</div>
1차 출처는 언리얼엔진 5.8 소스다. 핵심 파일은 <code>Engine/Source/Runtime/RHI/Private/RHIUtilities.cpp</code>(입력 마커와 지연 계산), <code>Engine/Source/Runtime/RHICore/Private/DXGIUtilities.cpp</code>(VBlank 추적 스레드), <code>Engine/Source/Runtime/Engine/Private/UnrealClient.cpp</code>(<code>stat unit</code> 표시), <code>Engine/Source/Runtime/Launch/Private/LaunchEngineLoop.cpp</code>(마커 위치), <code>Engine/Source/Runtime/RenderCore/Private/RenderingThread.cpp</code>(프레임 동기화)다. 본문의 줄 번호는 이 트리에서 실측한 값이고, 5.7과의 비교는 Epic의 공개 git 미러에서 태그를 직접 열어 확인했다.
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">01. 정의</span>
</div>

# Input은 입력을 읽은 순간부터 화면에 표시되기 시작할 때까지다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
Input은 게임 스레드가 이 프레임의 입력을 읽기 시작한 순간의 시간값과, 그 프레임이 실제로 모니터에 표시되기 시작한 순간의 시간값을 빼서 나온 값이다. 앞의 것은 이해하기 쉽다. 코드 어느 줄에 시간을 적는 함수를 하나 두면 된다. 뒤의 것은 조금 설명이 필요하다. 프레임이 모니터에 표시되기 시작하는 순간을 알려면 모니터가 화면을 어떻게 그리는지부터 알아야 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
모니터는 화면을 위에서 아래로 한 줄씩 그리고, 맨 아래까지 그린 뒤 다시 맨 위로 돌아가기 전에 잠깐 쉰다. 이 쉬는 구간이 VBlank(수직 공백)이고, 모니터가 읽어 가는 버퍼를 방금 렌더링을 마친 프레임으로 바꾸는 교체가 이 구간에서 일어난다. 엔진은 이 교체가 일어난 순간의 시간을 읽어 변수에 저장해 둔다. 이 글에서 "VBlank timestamp(시각)"이라고 부르는 값이 그것이다. timestamp는 어떤 일이 일어난 순간을 적어 둔 시간 값을 가리키는 말이고, UE 소스의 필드 이름도 <code>VBlankTimeInCycles</code>다. 걸린 시간이 아니라 몇 시 몇 분 몇 초처럼 한 시점을 가리키는 값이고, 그 시점이 곧 프레임이 화면에 표시되기 시작한 때다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="VBlank가 무엇인지: 모니터가 화면을 그리는 순서와 시간 축에서의 VBlank 구간">
<rect x="10" y="10" width="760" height="320" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="38" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#171a26">VBlank(수직 공백)가 정확히 무엇인가</text>

<!-- ===== left: monitor scan order ===== -->
<text x="30" y="64" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#414455">모니터가 화면을 그리는 순서</text>

<rect x="46" y="74" width="150" height="112" rx="4" fill="#f7f9fc" stroke="#c3c9d6" stroke-width="1.2"/>
<line x1="56" y1="86" x2="186" y2="86" stroke="#0a8f72" stroke-width="2"/>
<line x1="56" y1="98" x2="186" y2="98" stroke="#0a8f72" stroke-width="2"/>
<line x1="56" y1="110" x2="186" y2="110" stroke="#0a8f72" stroke-width="2"/>
<line x1="56" y1="122" x2="186" y2="122" stroke="#d5dbe6" stroke-width="1.5" stroke-dasharray="3 3"/>
<line x1="56" y1="134" x2="186" y2="134" stroke="#d5dbe6" stroke-width="1.5" stroke-dasharray="3 3"/>
<line x1="56" y1="146" x2="186" y2="146" stroke="#d5dbe6" stroke-width="1.5" stroke-dasharray="3 3"/>
<line x1="56" y1="158" x2="186" y2="158" stroke="#d5dbe6" stroke-width="1.5" stroke-dasharray="3 3"/>
<line x1="56" y1="170" x2="186" y2="170" stroke="#d5dbe6" stroke-width="1.5" stroke-dasharray="3 3"/>

<line x1="206" y1="82" x2="206" y2="166" stroke="#8ea2c8" stroke-width="1.6"/>
<polygon points="206,174 202,164 210,164" fill="#8ea2c8"/>
<text x="214" y="110" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#7e8295">한 줄씩</text>
<text x="214" y="126" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#7e8295">아래로</text>

<path d="M196,192 L196,208 L36,208 L36,92" fill="none" stroke="#c98a2e" stroke-width="1.6" stroke-dasharray="4 3"/>
<polygon points="36,84 32,94 40,94" fill="#c98a2e"/>
<text x="52" y="228" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#a9701c">맨 위로 돌아가는 이 사이가 VBlank</text>

<!-- ===== right: time axis ===== -->
<text x="280" y="64" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#414455">같은 일을 시간 축으로 늘어놓으면</text>

<rect x="280" y="80" width="140" height="42" rx="4" fill="#eef2fb" stroke="#8ea2c8" stroke-width="1.4"/>
<text x="290" y="106" font-family="Segoe UI, sans-serif" font-size="11" fill="#47597e">프레임 N 그리는 중</text>
<rect x="420" y="80" width="24" height="42" fill="#fdf3e2" stroke="#c98a2e" stroke-width="1.4"/>
<rect x="444" y="80" width="140" height="42" rx="4" fill="#eef2fb" stroke="#8ea2c8" stroke-width="1.4"/>
<text x="454" y="106" font-family="Segoe UI, sans-serif" font-size="11" fill="#47597e">프레임 N+1 그리는 중</text>
<rect x="584" y="80" width="24" height="42" fill="#fdf3e2" stroke="#c98a2e" stroke-width="1.4"/>
<rect x="608" y="80" width="110" height="42" rx="4" fill="#eef2fb" stroke="#8ea2c8" stroke-width="1.4"/>
<text x="618" y="106" font-family="Segoe UI, sans-serif" font-size="11" fill="#47597e">프레임 N+2</text>
<rect x="718" y="80" width="24" height="42" fill="#fdf3e2" stroke="#c98a2e" stroke-width="1.4"/>

<line x1="280" y1="136" x2="444" y2="136" stroke="#9aa3b5" stroke-width="1.2"/>
<line x1="280" y1="132" x2="280" y2="140" stroke="#9aa3b5" stroke-width="1.2"/>
<line x1="444" y1="132" x2="444" y2="140" stroke="#9aa3b5" stroke-width="1.2"/>
<text x="300" y="152" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">60Hz면 한 칸이 16.67ms</text>
<text x="460" y="152" font-family="Consolas, monospace" font-size="10.5" fill="#a9701c">노란 칸(VBlank)은 그중 1ms 안쪽</text>

<line x1="432" y1="122" x2="432" y2="166" stroke="#c98a2e" stroke-width="1.4" stroke-dasharray="4 3"/>
<rect x="300" y="168" width="440" height="58" rx="6" fill="#fdf3e2" stroke="#c98a2e" stroke-width="1.4"/>
<text x="314" y="190" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b5a3a">① 모니터가 읽어 갈 버퍼가 새로 렌더링한 프레임으로 교체된다</text>
<text x="314" y="212" font-family="Segoe UI, sans-serif" font-size="11" fill="#6b5a3a">② 엔진이 그 순간의 시간을 읽어 변수에 저장한다 = VBlank timestamp</text>

<!-- ===== notes ===== -->
<rect x="30" y="248" width="720" height="1" fill="#e3e8f0"/>
<text x="30" y="272" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#414455"><tspan font-weight="700">시각과 시간</tspan> VBlank timestamp(시각)는 걸린 시간이 아니다. 몇 시 몇 분 몇 초처럼 한 시점을 가리키는 값이다.</text>
<text x="30" y="294" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#414455"><tspan font-weight="700">Input이 쓰는 값</tspan> 이 값에서 입력을 읽을 때 저장해 둔 값을 빼면, 그 프레임의 지연이 시간으로 나온다.</text>
<text x="30" y="316" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">주의: 교체를 VBlank까지 기다리는 것은 VSync가 켜진 경우다. 즉시 표시 모드는 화면 중간에 바뀌고, 그때 티어링이 보인다.</text>
</svg>
<div class="scene-cap">모니터는 한 장을 다 그린 뒤 맨 위로 돌아가기까지 잠깐 쉰다. 이 빈 구간이 VBlank이고, 새 프레임으로 갈아타는 것도 시간을 기록하는 것도 여기서 일어난다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
두 시간이 준비되면 계산은 딱 한 줄이다. RHI 모듈의 <code>FRHIFrameInfo::SetVsyncDetails</code> 함수 안에 있다. 이 함수는 DirectX가 콜백으로 불러 주는 것이 아니다. 엔진이 VBlank를 감시하는 스레드를 하나 따로 띄우고, 그 스레드가 VBlank마다 깨어나서 이 함수를 부른다. 위에서 아래로 내려가는 호출 순서는 이렇다.
</p>

<div class="code-block"><span class="code-lang">호출 순서, 윈도우 D3D12 (UE 5.8)</span><span class="cm">// 1. 스왑체인을 만들 때 VBlank 감시 스레드를 하나 띄운다</span>
WindowsD3D12Viewport.cpp:177   FRHIFrameFlipStatTrackingRunnable::<span class="fn">Create</span>(SwapChain1)
DXGIUtilities.cpp:193          <span class="fn">StartThread</span>() → FRunnableThread::<span class="fn">Create</span>(..., "RHIFrameFlipStatTrackingRunnable")

<span class="cm">// 2. 그 스레드의 Run()이 게임이 끝날 때까지 아래를 반복한다</span>
DXGIUtilities.cpp:215          FRHIFrameFlipStatTrackingRunnable::<span class="fn">Run</span>()
  :232   SwapChain1-><span class="fn">GetContainingOutput</span>(Output)    <span class="cm">// 이 스왑체인이 붙어 있는 모니터(IDXGIOutput)를 얻는다</span>
  :258   Output-><span class="hl">WaitForVBlank</span>()                    <span class="cm">// IDXGIOutput::WaitForVBlank, 모니터의 다음 VBlank까지 스레드를 잠재운다</span>
  :288   SwapChain1-><span class="hl">GetFrameStatistics</span>(&amp;stats)     <span class="cm">// IDXGISwapChain::GetFrameStatistics, PresentCount와 SyncQPCTime을 받는다</span>
  :310   <span class="fn">RHIFrameInfoSetVsyncDetails</span>(NewFlipFrame)

<span class="cm">// 3. RHI 모듈로 넘어와 뺄셈을 한다</span>
RHIUtilities.cpp:885           <span class="fn">RHIFrameInfoSetVsyncDetails</span>() → GRHIFrameInfo.<span class="fn">SetVsyncDetails</span>()
RHIUtilities.cpp:775           FRHIFrameInfo::<span class="hl">SetVsyncDetails</span>()      <span class="cm">// 이 안에 아래 한 줄이 있다</span></div>

<p style="color:var(--text2);line-height:1.85;">
DirectX API는 두 개만 쓰인다. <code>IDXGIOutput::WaitForVBlank</code>는 모니터가 다음 VBlank에 들어갈 때까지 호출한 스레드를 잠재우는 함수다. 깨어난 직후 <code>IDXGISwapChain::GetFrameStatistics</code>로 방금 화면에 표시된 Present가 몇 번째였는지(<code>PresentCount</code>)와 그 순간의 시간(<code>SyncQPCTime</code>)을 받는다. 이 두 값을 담아 <code>SetVsyncDetails</code>를 부르면 아래 한 줄이 실행된다. 이 스레드가 어떻게 만들어지고 <code>GetFrameStatistics</code>가 무엇을 돌려주는지는 03장에서 코드로 본다.
</p>

<div class="code-block"><span class="code-lang">C++, RHIUtilities.cpp (UE 5.8)</span><span class="kw">if</span> (VBlankTimeInCycle > Elem.Value.InputCycle)
{
	CurrentInputLatency = VBlankTimeInCycle - Elem.Value.InputCycle;
}

<span class="kw">if</span> (CurrentInputLatency)
{
	GInputLatencyTime = CurrentInputLatency;
}</div>

<p style="color:var(--text2);line-height:1.85;">
앞에서 말한 두 시간이 그대로 변수로 들어와 있다. <code>InputCycle</code>은 게임 스레드가 그 프레임의 입력을 읽기 시작할 때 적어 둔 시간이고, <code>VBlankTimeInCycle</code>은 그 프레임이 모니터에 표시되기 시작한 시간이다. 이름 끝의 Cycle은 단위를 말한다. 둘 다 <code>FPlatformTime::Cycles64()</code>로 읽은 값인데, 이 함수는 실제로 흐른 시간을 아주 잘게 세는 카운터를 돌려준다. 같은 카운터에서 읽은 값이라 그대로 빼면 두 시점 사이에 흐른 시간이 되고, 초나 밀리초로 바꾸려면 정해진 배율만 곱하면 된다. <strong>즉 Input은 엔진이 입력을 읽기 시작한 순간부터 그 결과가 화면에 그려지기 시작한 순간까지다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
정의는 이걸로 끝이다. 이 글의 나머지는 두 시간을 각각 코드의 어디서 적는지, 왜 하필 그 자리인지를 확인하는 과정이다. 값을 담는 구조체를 보면 설계 의도가 주석에 적혀 있다.
</p>

<div class="code-block"><span class="code-lang">C++, RHIUtilities.h (UE 5.8)</span><span class="kw">struct</span> <span class="ty">FRHIFrameInfoMarker</span>
{
	<span class="cm">//Present Counter that correlate the the Game Frame Index</span>
	<span class="kw">uint64</span> PresentCounter = <span class="num">0</span>;
	<span class="cm">//Wall clock cycles when Input was sample on the CPU</span>
	<span class="kw">uint64</span> InputCycle = <span class="num">0</span>;
	<span class="cm">//Wall clock cycles when the frame was flip to the Display composition</span>
	<span class="kw">uint64</span> VSyncCycle = <span class="num">0</span>;
	<span class="cm">//Frame Input latency from InputCycle to Display composition in milliseconds</span>
	<span class="kw">double</span> InputLatencyMS = <span class="num">0.0</span>;
};</div>

<p style="color:var(--text2);line-height:1.85;">
마지막 주석 줄이 공식 정의다. <strong>"InputCycle에서 Display composition까지"</strong>. Display composition은 모니터에 보낼 최종 화면이 만들어지는 단계를 말한다. 컨트롤러도 아니고, 픽셀도 아니다. 이 구조체는 프레임 번호를 키로 하는 맵에 들어가고, 최근 16프레임 분량만 남긴다(<code>FrameInfoHistoryCount = 16</code>). 왜 프레임마다 따로 보관하느냐면, 두 시간을 서로 다른 스레드가 서로 다른 때에 적기 때문이다. 입력 쪽은 게임 스레드가 프레임 시작에 적는다. 화면에 표시되기 시작한 시간은 전혀 다른 스레드가 몇 프레임 뒤에야 알게 된다. 그때 어느 프레임의 입력 시간과 짝을 맞출지 알아야 하니, 프레임 번호를 키로 둘을 한 자리에 모아 둔다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Input 값이 재는 구간과 재지 않는 구간">
<rect x="10" y="10" width="760" height="280" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="30" y="40" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#171a26">버튼을 누른 순간부터 픽셀이 바뀔 때까지의 전체 경로</text>

<!-- excluded left -->
<rect x="30" y="60" width="108" height="58" rx="6" fill="#f5f6fa" stroke="#c3c9d6" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="42" y="82" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#7e8295">패드, 폴링</text>
<text x="42" y="100" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">USB 1~8ms</text>
<text x="42" y="112" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">BT 추가</text>

<!-- excluded queue -->
<rect x="146" y="60" width="96" height="58" rx="6" fill="#f5f6fa" stroke="#c3c9d6" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="158" y="82" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#7e8295">OS 큐 대기</text>
<text x="158" y="100" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">0~1 프레임</text>
<text x="158" y="112" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">평균 0.5f</text>

<!-- measured region -->
<rect x="250" y="60" width="396" height="58" rx="6" fill="#eefaf6" stroke="#0a8f72" stroke-width="2"/>
<text x="262" y="82" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#0a8f72">입력 마커 → Game → Render → RHI/GPU → Present 큐 → VBlank</text>
<text x="262" y="102" font-family="Consolas, monospace" font-size="10.5" fill="#41775f">stat unit 의 Input 이 재는 구간 전부</text>
<text x="262" y="114" font-family="Consolas, monospace" font-size="10.5" fill="#41775f">파이프라인 깊이 + VSync 대기가 여기 다 들어온다</text>

<!-- excluded display -->
<rect x="654" y="60" width="96" height="58" rx="6" fill="#f5f6fa" stroke="#c3c9d6" stroke-width="1.2" stroke-dasharray="4 3"/>
<text x="666" y="82" font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#7e8295">디스플레이</text>
<text x="666" y="100" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">화면에 그림</text>
<text x="666" y="112" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">+ 응답시간</text>

<!-- bracket -->
<line x1="250" y1="140" x2="646" y2="140" stroke="#0a8f72" stroke-width="2"/>
<line x1="250" y1="132" x2="250" y2="148" stroke="#0a8f72" stroke-width="2"/>
<line x1="646" y1="132" x2="646" y2="148" stroke="#0a8f72" stroke-width="2"/>
<text x="352" y="164" font-family="Consolas, monospace" font-size="12" font-weight="700" fill="#0a8f72">Input = VBlankCycle − InputCycle</text>

<line x1="30" y1="140" x2="242" y2="140" stroke="#c3c9d6" stroke-width="1.5" stroke-dasharray="4 3"/>
<line x1="654" y1="140" x2="750" y2="140" stroke="#c3c9d6" stroke-width="1.5" stroke-dasharray="4 3"/>
<text x="86" y="162" font-family="Segoe UI, sans-serif" font-size="11" fill="#9aa3b5">측정 밖</text>
<text x="672" y="162" font-family="Segoe UI, sans-serif" font-size="11" fill="#9aa3b5">측정 밖</text>

<!-- notes -->
<rect x="30" y="188" width="720" height="1" fill="#e3e8f0"/>
<text x="30" y="212" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#414455"><tspan font-weight="700">그래서</tspan> 실제 체감 지연은 항상 이 숫자보다 크다. 왼쪽 두 칸과 오른쪽 한 칸이 더해지기 때문이다.</text>
<text x="30" y="234" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#414455"><tspan font-weight="700">반대로</tspan> 엔진 코드로 줄일 수 있는 구간은 정확히 초록 박스 안쪽이다. 그래서 최적화 계측기로는 이 범위가 맞다.</text>
<text x="30" y="256" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#414455"><tspan font-weight="700">단위 감각</tspan> 60Hz에서 1프레임 = 16.67ms. 초록 구간이 40ms면 파이프라인 깊이가 대략 2.4프레임이라는 뜻이다.</text>
<text x="30" y="278" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">주의: 마커는 이벤트가 도착한 시각이 아니라 "이제 이 프레임의 입력을 처리한다"고 선언한 시각이다(02장).</text>
</svg>
<div class="scene-cap">Input이 덮는 구간과 덮지 않는 구간. 엔진이 통제할 수 있는 범위와 계측 범위가 일치하는 것은 우연이 아니라 그렇게 설계한 결과다.</div>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">02. 시작점</span>
</div>

# 입력을 읽기 시작한 시간은 엔진 루프의 어디서 기록하나

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
시작 시간을 적는 쪽은 게임 스레드다. 위치는 엔진 루프 안, <strong>OS 메시지 펌프 바로 앞</strong>이다. 메시지 펌프가 무엇인지 짚고 가자. 윈도우는 키보드와 마우스 이벤트를 프로그램별 큐에 쌓아 둔다. 프로그램은 매 프레임 <code>PumpMessages</code>를 불러 그 큐를 비우고, 그때서야 이벤트가 엔진 안으로 들어온다. 이 글에서는 이렇게 시간을 적어 두는 코드를 마커라고 부른다.
</p>

<div class="code-block"><span class="code-lang">C++, LaunchEngineLoop.cpp:5781 (UE 5.8)</span><span class="cm">// Don't pump messages if we're running embedded as the outer application</span>
<span class="cm">// will pass us messages instead.</span>
<span class="kw">if</span> (!GUELibraryOverrideSettings.bIsEmbedded)
{
	GEngine-><span class="fn">SetInputSampleLatencyMarker</span>(CurrentFrameCounter);

	<span class="hl">SCOPED_NAMED_EVENT</span>(FEngineLoop_PumpMessages, SystemColor);
	FPlatformApplicationMisc::<span class="fn">PumpMessages</span>(<span class="kw">true</span>);
}</div>

<p style="color:var(--text2);line-height:1.85;">
<code>CurrentFrameCounter</code>는 이번 틱, 즉 엔진 루프가 이번 프레임을 시작할 때 <code>GFrameCounter</code>를 복사해 둔 값이다. 이 프레임 번호가 나중에 Present와 짝지을 때 키로 쓰인다. 마커 함수 안에는 조건 분기가 없다. 같은 순간을 알아야 하는 곳이 두 군데라서, 매 프레임 두 가지를 차례로 실행할 뿐이다.
</p>

<div class="code-block"><span class="code-lang">C++, UnrealEngine.cpp:2889 (UE 5.8)</span><span class="kw">void</span> UEngine::<span class="fn">SetInputSampleLatencyMarker</span>(<span class="kw">uint64</span> FrameNumber)
{
	TArray&lt;ILatencyMarkerModule*&gt; LatencyMarkerModules = IModularFeatures::<span class="fn">Get</span>()
		.<span class="fn">GetModularFeatureImplementations</span>&lt;ILatencyMarkerModule&gt;(ILatencyMarkerModule::<span class="fn">GetModularFeatureName</span>());

	<span class="hl">RHIFrameInfoSetInputSampleMarker</span>(FrameNumber);

	<span class="kw">for</span> (ILatencyMarkerModule* LatencyMarkerModule : LatencyMarkerModules)
	{
		LatencyMarkerModule-><span class="fn">SetInputSampleLatencyMarker</span>(FrameNumber);
	}
}</div>

<p style="color:var(--text2);line-height:1.85;">
두 호출은 하는 일이 다르다. 첫 줄 <code>RHIFrameInfoSetInputSampleMarker</code>는 엔진 자신의 기록이다. 지금 시간을 엔진 메모리의 맵에 적어 두고, <code>stat unit</code>의 Input은 이 값만 쓴다. 뒤의 반복문은 <code>ILatencyMarkerModule</code>을 구현하고 "LatencyMarker"라는 이름으로 등록한 플러그인 전부에게 같은 사실을 알린다. NVIDIA Reflex 플러그인이 그중 하나이고, AMD와 인텔의 플러그인도 같은 자리에 붙는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
플러그인 쪽은 시간을 적어 두지 않는다. 프레임 N이 방금 입력을 읽었다는 사실을 GPU 드라이버에 넘길 뿐이다. 드라이버는 그 정보로 게임 스레드를 언제 깨울지 정하고, 자기 기준의 지연 수치를 따로 만든다(09장). 그러니 두 경로는 값이 가는 곳이 아예 다르고, 서로의 값을 쓰지도 않는다. 플러그인이 하나도 없거나 꺼져 있으면 배열이 비어 있어서 반복문은 아무 일도 하지 않는다. 보통의 빌드에서는 첫 줄만 도는 셈이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
RHI 쪽 구현은 프레임 번호를 키로 맵에 항목을 만들고 지금 시간을 적어 둔다. 락을 잡는 이유는 이 맵을 나중에 다른 스레드가 읽기 때문이다.
</p>

<div class="code-block"><span class="code-lang">C++, RHIUtilities.cpp:748 (UE 5.8)</span><span class="kw">void</span> FRHIFrameInfo::<span class="fn">SetInputSampleMarker</span>(<span class="kw">uint64</span> FrameIndex)
{
	<span class="kw">uint64</span> Cycles64 = FPlatformTime::<span class="fn">Cycles64</span>();

	{
		UE::TUniqueLock <span class="fn">ScopeLock</span>(FramesMutex);

		FRHIFrameInfoMarker&amp; FrameMarker = Frames.<span class="fn">FindOrAdd</span>(FrameIndex);
		FrameMarker.InputCycle = Cycles64;
		<span class="fn">Trim</span>();
	}
}</div>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">왜 이 자리가 "버튼을 누른 시점"이 아닌가</h2>

<p style="color:var(--text2);line-height:1.85;">
이 글에서 가장 중요한 부분이다. 마커는 <code>PumpMessages</code> <strong>앞</strong>에 있다. 메시지 펌프는 그때까지 OS 큐에 쌓여 있던 이벤트를 꺼내 온다. 그러니 <strong>이 프레임이 처리하는 키보드, 마우스 이벤트는 모두 마커보다 먼저 발생해 있었다.</strong> 마커가 가리키는 것은 입력이 들어온 시점이 아니라, 엔진이 이번 프레임의 입력을 지금부터 처리하겠다고 정한 시점이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 키보드, 마우스처럼 메시지로 들어오는 입력에서는 이 값이 <strong>구조상 실제 지연보다 짧게 나온다.</strong> 버튼이 프레임 경계를 막 지나서 눌렸다면 그 이벤트는 다음 마커까지 최대 한 프레임을 큐에서 기다린다. 평균으로 보면 반 프레임이고, 60Hz에서는 약 8ms다. 이 시간은 Input 값에 들어가지 않는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
게임패드는 입력을 읽는 동작이 키보드, 마우스와 다르다. XInput 패드는 메시지로 들어오지 않는다. 엔진이 매 프레임 직접 패드 상태를 물어보는데, 그 조회가 마커보다 뒤에서 일어난다. 엔진 루프의 순서는 마커 → 메시지 펌프 → 여러 작업 → 입력 샘플 델리게이트 → Slate의 장치 조회다. 그러니 패드 입력은 마커 시점보다 조금 뒤에 읽히고, 그 차이는 Input 값에 들어가지 않는다.
</p>

<div class="code-block"><span class="code-lang">C++, LaunchEngineLoop.cpp:5830~5850 (UE 5.8, 순서 발췌)</span><span class="cm">// Roughly track the time when the input was sampled</span>
{
	<span class="hl">SCOPED_NAMED_EVENT_TEXT</span>(<span class="str">"FCoreDelegates::OnSamplingInput"</span>, CoreDelegatesColor);
	FCoreDelegates::OnSamplingInput.<span class="fn">Broadcast</span>();
}

<span class="cm">// process accumulated Slate input</span>
<span class="kw">if</span> (FSlateApplication::<span class="fn">IsInitialized</span>() &amp;&amp; !bIdleMode)
{
	...
	SlateApp.<span class="fn">PollGameDeviceState</span>();     <span class="cm">// ← XInputGetState 가 여기서 불린다</span>
	SlateApp.<span class="fn">FinishedInputThisFrame</span>();
}</div>

<p style="color:var(--text2);line-height:1.85;">
주석에도 한계가 그대로 적혀 있다. <strong>"Roughly track the time when the input was sampled"</strong>. 대략적으로 추적한다는 뜻이다. 참고로 이 델리게이트가 갱신하는 <code>GInputTime</code> 전역은 5.8에서는 지연 계산에 쓰이지 않는다. 5.7까지는 이 값이 계산의 시작점이었고, 5.8에서 마커 방식으로 바뀌며 남은 흔적이다(07장).
</p>

<div class="callout callout-warn">
<div class="callout-title">보고서에 쓸 때의 문장</div>
<p>Input 값을 두고 "우리 게임의 입력 지연은 X ms입니다"라고 쓰면 틀린다. 정확하게는 <strong>"입력을 읽은 시점부터 화면에 표시되기 시작할 때까지 X ms이고, 여기에 장치 조회 주기와 이벤트 큐 대기, 모니터 내부 처리가 더해집니다"</strong>다. 경쟁 장르에서 이 차이는 보통 10~30ms이며, 무선 패드와 TV를 쓰면 더 벌어진다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">03. 끝점</span>
</div>

# 프레임이 화면에 표시되기 시작한 시간은 어디서 받아 오나: 전용 스레드와 DXGI

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
끝점, 즉 프레임이 화면에 표시되기 시작한 시간은 엔진의 세 CPU 스레드 어느 쪽도 알 수 없다. 게임 스레드는 게임 로직을 돌리고, 렌더 스레드는 무엇을 그릴지 목록을 만들고, RHI 스레드는 그 목록을 그래픽 API 호출로 바꿔 GPU에 넘긴다. RHI 스레드가 하는 일 가운데 Present가 있다. 다 그린 프레임을 화면에 내보내 달라고 그래픽 API에 넘기는 호출이다. Present를 호출한 시점은 RHI 스레드가 안다. 하지만 그 프레임이 <em>실제로</em> 모니터에 표시되기 시작한 시점은 그 뒤에 모니터 쪽에서 벌어지는 일이라서, 엔진 스레드 어느 쪽도 그 순간을 직접 보지 못한다. 그래서 UE는 전용 스레드를 하나 띄워 VBlank마다 깨어나게 한다. 윈도우에서 이 정보를 알려 주는 쪽은 DXGI다. 화면에 내보낼 버퍼 묶음인 스왑체인을 만들고 Present를 처리하는, 윈도우에서 그래픽 출력을 담당하는 구성 요소다.
</p>

<div class="code-block"><span class="code-lang">C++, DXGIUtilities.cpp (UE 5.8, 발췌)</span><span class="kw">while</span> (bRun)
{
	...
	<span class="cm">// Blocking Wait for the next monitor VBlank, yielding the CPU (not busy-waiting)</span>
	<span class="hl">TRACE_CPUPROFILER_EVENT_SCOPE</span>(IDXGIOutput::WaitForVBlank_NoBusyWait);
	HRESULT WaitForVblankHR = Output-><span class="fn">WaitForVBlank</span>();

	<span class="kw">if</span> (WaitForVblankHR == S_OK)
	{
		<span class="kw">uint64</span> VsyncCycles = FPlatformTime::<span class="fn">Cycles64</span>();
		...
		DXGI_FRAME_STATISTICS stats = { <span class="num">0</span> };

		<span class="kw">if</span> (<span class="fn">SUCCEEDED</span>(GetStatHR = SwapChain1-><span class="fn">GetFrameStatistics</span>(&amp;stats))
			&amp;&amp; (stats.PresentCount > LastFlipFrame.PresentIndex))
		{
			FRHIFlipDetails NewFlipFrame;
			NewFlipFrame.PresentIndex      = stats.PresentCount;
			NewFlipFrame.VBlankTimeInCycles = stats.<span class="hl">SyncQPCTime</span>.QuadPart;
			NewFlipFrame.Hz                = Hz;
			...
			<span class="hl">RHIFrameInfoSetVsyncDetails</span>(NewFlipFrame);
		}
	}
}</div>

<p style="color:var(--text2);line-height:1.85;">
여기서 중요한 것은 어느 값을 쓰느냐다. 이 스레드가 깨어난 시점이 아니라, DXGI가 알려 주는 <code>SyncQPCTime</code>을 쓴다. 스레드가 깨어나는 시점은 OS 스케줄러가 언제 깨워 주느냐에 따라 매번 조금씩 흔들린다. 반면 <code>SyncQPCTime</code>은 그 Present가 실제로 화면에 표시되기 시작한 시점을 드라이버가 기록해 둔 값이다. 스레드가 깨어난 시점(<code>VsyncCycles</code>)은 주사율을 계산하고 놓친 VBlank를 표시하는 데만 쓰인다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그런데 <code>GetFrameStatistics</code>가 알려 주는 것은 <strong>Present 카운터</strong>다. 게임 프레임 번호가 아니다. Present를 몇 번째로 했는지만 세는 값이라, 게임 쪽 프레임 번호와 맞춰 줄 단계가 하나 더 필요하다. Present 직전에 "게임 프레임 N이 곧 Present 카운터 M이 된다"를 적어 두는 일이다.
</p>

<div class="code-block"><span class="code-lang">C++, D3D12Viewport.cpp:892 / SlateRHIRenderer.cpp:1320 (UE 5.8)</span><span class="cm">// Slate: present 인자에 렌더 스레드의 프레임 번호를 실어 보낸다</span>
RHICmdList.<span class="fn">EndDrawingViewport</span>(ViewportRHI,
	<span class="fn">FRHIPresentArgs</span>(<span class="cm">/*.FrameCounter*/</span> GFrameCounterRenderThread, ...));

<span class="cm">// D3D12: Present 하기 직전, RHI 스레드에서 짝을 기록</span>
<span class="cm">// Not all platforms have control on the Present Counter, correlate the information</span>
<span class="cm">// FrameCounter -> PresentCounter before Presenting the frame</span>
<span class="hl">RHIFrameInfoSetPresentCounter</span>(PresentArgs.FrameCounter, GRHIPresentCounter);</div>

<p style="color:var(--text2);line-height:1.85;">
이제 필요한 값이 셋 다 모였다. 프레임 N의 입력 시간(게임 스레드가 적음), 프레임 N과 Present M의 짝(RHI 스레드가 적음), Present M이 화면에 표시되기 시작한 시간(전용 스레드가 적음)이다. 마지막 함수가 이 셋을 합쳐 뺄셈을 한다. 맵을 훑어 Present 카운터가 일치하는 프레임을 찾는 방식이다.
</p>

<div class="code-block"><span class="code-lang">C++, RHIUtilities.cpp (UE 5.8, SetVsyncDetails 발췌)</span><span class="kw">for</span> (TPair&lt;<span class="kw">uint64</span>, FRHIFrameInfoMarker&gt;&amp; Elem : Frames)
{
	<span class="kw">if</span> (Elem.Value.PresentCounter == NewFlipFrame.PresentIndex)
	{
		<span class="cm">//if VBlankTimeInCycles is not set we compute it from VBlankTimeInSeconds</span>
		<span class="kw">uint64</span> VBlankTimeInCycle = (NewFlipFrame.VBlankTimeInCycles != <span class="num">0</span>)
			? NewFlipFrame.VBlankTimeInCycles
			: ((<span class="kw">uint64</span>)(NewFlipFrame.VBlankTimeInSeconds / FPlatformTime::<span class="fn">GetSecondsPerCycle64</span>()));

		Elem.Value.VSyncCycle = VBlankTimeInCycle;
		...
		<span class="kw">if</span> (VBlankTimeInCycle > Elem.Value.InputCycle)
		{
			CurrentInputLatency = VBlankTimeInCycle - Elem.Value.InputCycle;
		}
		<span class="kw">if</span> (CurrentInputLatency)
		{
			<span class="hl">GInputLatencyTime</span> = CurrentInputLatency;
		}
		Elem.Value.InputLatencyMS = FPlatformTime::<span class="fn">ToMilliseconds64</span>(CurrentInputLatency);
	}
}</div>

<p style="color:var(--text2);line-height:1.85;">
여기 방어 코드가 두 개 있다. <code>VBlankTimeInCycle > InputCycle</code> 검사와 <code>if (CurrentInputLatency)</code> 검사다. 짝을 못 찾거나 두 시간의 앞뒤가 뒤집히면 <strong>새 값을 쓰지 않고 직전 값을 그대로 둔다.</strong> 그래서 화면의 Input이 한동안 안 바뀌고 멈춰 있을 수 있다. 대신 0이 표시되는 일은 없다. 값이 0이면 아직 한 번도 계산에 성공하지 못했다는 뜻이고, 그때는 행 자체가 그려지지 않는다(06장).
</p>

<div class="flow-row">
<div class="flow-step hot">
<div class="step-num">① 게임 스레드</div>
<div class="step-name">InputCycle 기록</div>
<div class="step-desc">프레임 N 시작, 메시지 펌프 직전. 키는 <code>GFrameCounter</code>.</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">② RHI 스레드</div>
<div class="step-name">N ↔ Present M</div>
<div class="step-desc">Present 직전에 프레임 번호와 Present 카운터의 짝을 같은 자리에 기록.</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step">
<div class="step-num">③ VBlank 스레드</div>
<div class="step-name">SyncQPCTime 획득</div>
<div class="step-desc"><code>WaitForVBlank</code>로 깨어나 <code>GetFrameStatistics</code>로 Present M이 실제로 화면에 표시되기 시작한 시간을 읽음.</div>
</div>
<div class="flow-arrow">→</div>
<div class="flow-step hot">
<div class="step-num">④ 뺄셈</div>
<div class="step-name">GInputLatencyTime</div>
<div class="step-desc">Present 카운터로 자리를 찾아 <code>VBlank − Input</code>. 전역 하나에 사이클 단위로 저장.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
스레드가 셋이나 끼어드는데도 락은 프레임 맵 하나뿐이다. 계산 결과도 <code>GInputLatencyTime</code> 전역 하나로 끝난다. 이 값은 <code>RHICommandList.cpp</code>에 <code>uint64</code>로 선언되어 있고, 다음 장의 표시 코드는 이 전역을 그냥 읽는다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">04. 표시</span>
</div>

# 화면에 보이는 값은 매 프레임 계산값이 아니라 평균낸 값이다

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
계산된 값이 그대로 화면에 찍히지는 않는다. <code>stat unit</code> 갱신 함수가 밀리초로 바꾸고 평균을 낸다. 다른 행들과 똑같은 처리다.
</p>

<div class="code-block"><span class="code-lang">C++, UnrealClient.cpp:401 (UE 5.8)</span>RawInputLatencyTime = FPlatformTime::<span class="fn">ToMilliseconds64</span>(GInputLatencyTime);
InputLatencyTime = <span class="num">0.9</span> * InputLatencyTime + <span class="num">0.1</span> * RawInputLatencyTime;</div>

<p style="color:var(--text2);line-height:1.85;">
직전까지의 평균에 90%, 이번 프레임 값에 10%의 비중을 주는 방식이다. 새 값이 조금씩만 섞이니 화면 숫자가 튀지 않는 대신, 변화가 다 반영되기까지 열 프레임 남짓 걸린다. 60Hz면 <strong>0.2초 정도</strong>다. 콘솔 변수를 바꾸고 바로 숫자를 읽으면 아직 이전 값이 섞여 있다는 뜻이다. 평균내지 않은 매 프레임 계산값을 보려면 <code>stat raw</code>를 같이 켠다.
</p>

<div class="code-block"><span class="code-lang">C++, UnrealClient.cpp:454 (UE 5.8)</span><span class="kw">const bool</span> bShowRawUnitTimes = Client &amp;&amp; Client-><span class="fn">IsStatEnabled</span>(<span class="str">TEXT("Raw")</span>);
...
InputLatencyTimes[CurrentIndex] = bShowRawUnitTimes ? RawInputLatencyTime : InputLatencyTime;</div>

<p style="color:var(--text2);line-height:1.85;">
Max 칸은 <code>stat unitmax</code>로 켜고, 최근 200프레임 중 가장 큰 값을 보여 준다(<code>NumberOfSamples = 200</code>). 60Hz면 약 3.3초 구간이다. 여기서 주의할 점이 하나 있다. <strong><code>stat raw</code>를 켜지 않으면 Max도 평균낸 값들 중의 최대</strong>라서, 실제로 튄 값보다 낮게 나온다. 순간적으로 튀는 값을 잡으려면 Raw와 UnitMax를 함께 켜야 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
숫자에 붙는 색은 기준이 따로 있다. 다른 행들은 프레임 예산과 비교해 색이 정해지는데, Input은 값을 2.5로 나눈 뒤 같은 비교에 넣는다.
</p>

<div class="code-block"><span class="code-lang">C++, UnrealClient.cpp:801 (UE 5.8)</span><span class="kw">const float</span> ReasonableInputLatencyFactor = <span class="num">2.5f</span>;
<span class="fn">DrawTitleString</span>(<span class="str">TEXT("Input")</span>, <span class="cm">/* UnitGraphColor = */</span> <span class="fn">FColor</span>(<span class="num">255</span>, <span class="num">255</span>, <span class="num">100</span>));
{
	<span class="kw">const</span> FColor InputLatencyAverageColor =
		GEngine-><span class="fn">GetFrameTimeDisplayColor</span>(InputLatencyTime / ReasonableInputLatencyFactor);
	<span class="fn">DrawDefaultAvgCell</span>(<span class="fn">FString::Printf</span>(STATUNIT_FORMAT_AVGTIME, InputLatencyTime), InputLatencyAverageColor);
}</div>

<p style="color:var(--text2);line-height:1.85;">
즉 엔진은 <strong>입력 지연이 프레임 시간의 2.5배쯤인 것을 "정상"으로 본다.</strong> 그런데 여기서 비교되는 프레임 시간은 프로젝트의 목표 프레임 레이트가 아니다. 색 판정 함수는 고정된 콘솔 변수 두 개를 쓴다. 초록과 주황의 경계가 <code>t.TargetFrameTimeThreshold</code> 기본 <strong>33.9ms</strong>, 주황과 빨강의 경계가 <code>t.UnacceptableFrameTimeThreshold</code> 기본 <strong>50ms</strong>다. 두 변수의 주석에는 이 값이 "cosmetic only", 즉 표시용일 뿐이니 품질 단계를 정하는 스케일러빌리티 코드에서 쓰지 말라고 적혀 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
2.5로 나눈 값을 이 기준에 넣으면 실제 경계가 나온다. <strong>Input이 약 85ms까지는 초록이고, 125ms를 넘어야 빨강이다.</strong> 60fps를 목표하는 프로젝트에서 5프레임짜리 지연이 초록으로 표시된다는 뜻이다. 이 기본값에 엔진이 무엇을 정상으로 보는지가 드러난다. 파이프라인이 두세 프레임 깊은 것은 예외 상황이 아니라 기본 구성이다. 그래서 경쟁 장르에서는 <strong>색은 보지 말고 숫자만 봐야 한다.</strong>
</p>

<div class="data-table">
<table>
<tr><th>보이는 것</th><th>실제 값</th><th>켜는 방법</th><th>주의</th></tr>
<tr><td>Input avg</td><td>직전 평균 90% + 새 값 10%. 열 프레임쯤 지나야 다 반영</td><td><code>stat unit</code></td><td>변경 후 0.2초 기다려야 안정</td></tr>
<tr><td>Input avg (raw)</td><td>가장 최근에 계산에 성공한 값 하나</td><td><code>stat unit</code> + <code>stat raw</code></td><td>짝을 못 찾으면 직전 값을 그대로 둬서 멈춘 것처럼 보인다</td></tr>
<tr><td>Input max</td><td>최근 200프레임 중 최대</td><td>+ <code>stat unitmax</code></td><td>Raw 없이는 평균낸 값들 중의 최대라 낮게 나온다</td></tr>
<tr><td>색</td><td>값 ÷ 2.5를 고정 임계값(33.9ms, 50ms)과 비교</td><td>자동</td><td>약 85ms까지 초록, 125ms 넘어야 빨강. 목표 프레임 레이트와 무관</td></tr>
<tr><td>통계 시스템 값</td><td><code>STAT_InputLatencyTime</code>(Engine 그룹)</td><td><code>stat engine</code>, CSV, Insights</td><td>평균낸 값이 들어간다. 매 프레임 계산값이 아니다</td></tr>
</table>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">05. 빠진 구간</span>
</div>

# 버튼을 누른 순간부터 픽셀이 바뀔 때까지의 시간을 추정하는 법

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
Input이 재지 않는 구간을 하나씩 더하면 플레이어가 체감하는 지연의 추정값이 된다. 버튼을 누른 순간부터 픽셀이 실제로 밝아질 때까지를 업계에서는 click-to-photon이라고 부른다. 각 구간의 크기는 하드웨어와 설정에 따라 달라지니, 여기서는 어떤 구간이 있고 무엇에 따라 커지는지만 정리한다.
</p>

<div class="data-table">
<table>
<tr><th>구간</th><th>Input에 포함?</th><th>크기를 정하는 요인</th></tr>
<tr><td>버튼 접점 → 패드 안의 칩</td><td>아니오</td><td>패드가 버튼 상태를 읽는 주기, 접점 떨림을 걸러 내는 대기 시간</td></tr>
<tr><td>패드 → PC/콘솔</td><td>아니오</td><td>유선은 USB로 상태를 보내는 주기, 무선은 전송 방식과 연결 상태</td></tr>
<tr><td>OS 큐 대기 → 입력 마커</td><td>아니오</td><td>이벤트가 프레임 시작 직후에 왔는지 직전에 왔는지. 0~1프레임</td></tr>
<tr><td>마커 → 게임 스레드 시뮬레이션</td><td><strong>예</strong></td><td>게임 스레드 시간, 틱 순서</td></tr>
<tr><td>게임 → 렌더 스레드</td><td><strong>예</strong></td><td>두 스레드를 얼마나 겹쳐 돌릴지(<code>r.OneFrameThreadLag</code>)</td></tr>
<tr><td>렌더 → RHI → GPU 실행</td><td><strong>예</strong></td><td>RHI 스레드를 몇 프레임 겹칠지(<code>r.GTSyncType</code>), GPU 시간</td></tr>
<tr><td>Present 큐 대기</td><td><strong>예</strong></td><td>백버퍼 개수, VSync, 프레임 간격을 고르게 맞추는 설정</td></tr>
<tr><td>VBlank에서 프레임 교체 → 픽셀 색이 실제로 바뀜</td><td>아니오</td><td>화면 위아래 중 어디인지, 모니터 내부 처리, 응답 속도</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
이 표에서 실무 결론이 하나 나온다. <strong>엔진 코드로 줄일 수 있는 구간과 Input이 재는 구간이 정확히 겹친다.</strong> 그래서 이 숫자를 스펙으로 내놓기에는 부족하지만, 방금 한 변경이 파이프라인을 얼마나 얕게 만들었는지 재는 데는 알맞다. 스펙으로 쓸 절대값이 필요하면 계측 장비나 고속 카메라로 재야 하고, 그때 Input은 그 측정값을 구간별로 쪼개 해석하는 기준선이 된다.
</p>

<div class="callout callout-teal">
<div class="callout-title">두 숫자를 함께 쓰는 법</div>
<p>장비로 잰 버튼부터 픽셀까지의 시간이 70ms이고 Input이 40ms라면, 나머지 30ms는 엔진 밖에 있다는 뜻이다. 컨트롤러, 이벤트 큐 대기, 모니터 몫이다. 엔진 안에서 아무리 줄여도 최대 40ms까지만 줄일 수 있다는 상한이 바로 나온다. 반대로 실측이 45ms인데 Input이 40ms라면 컨트롤러와 모니터는 이미 좋은 상태이고, 남은 개선 여지는 전부 파이프라인 안에 있다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">06. 보이는 조건</span>
</div>

# 왜 어떤 빌드에서는 이 행이 아예 없나

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
Input 행이 안 보일 때 버그를 의심하기 전에 확인할 것이 있다. 이 계측은 <strong>빌드할 때 코드째로 빠질 수 있는 기능</strong>이다. 조건은 매크로 하나에 정리되어 있다.
</p>

<div class="code-block"><span class="code-lang">C++, RHIUtilities.h:20 (UE 5.8)</span><span class="kw">#if</span> !UE_BUILD_SHIPPING &amp;&amp; PLATFORM_SUPPORTS_FLIP_TRACKING
	<span class="kw">#define</span> UE_INPUT_LATENCY_TRACKING 1
<span class="kw">#else</span>
	<span class="kw">#define</span> UE_INPUT_LATENCY_TRACKING 0
<span class="kw">#endif</span></div>

<p style="color:var(--text2);line-height:1.85;">
두 조건을 모두 만족해야 한다. 첫째, Shipping 빌드가 아니어야 한다. 둘째, 플랫폼 플래그가 켜져 있어야 한다. 이 플래그는 <strong>공통 기본값이 0</strong>이라, 플랫폼별 헤더가 1로 덮어써야 켜진다.
</p>

<div class="code-block"><span class="code-lang">C++, Platform.h:618 / WindowsPlatform.h:62 (UE 5.8)</span><span class="cm">// 공통 기본값</span>
<span class="kw">#ifndef</span> PLATFORM_SUPPORTS_FLIP_TRACKING
	<span class="kw">#define</span> PLATFORM_SUPPORTS_FLIP_TRACKING 0
<span class="kw">#endif</span>

<span class="cm">// 윈도우</span>
<span class="kw">#define</span> PLATFORM_SUPPORTS_FLIP_TRACKING						1</div>

<p style="color:var(--text2);line-height:1.85;">
그래서 <strong>이 행이 안 보이면 먼저 자기 플랫폼 헤더에서 이 플래그를 확인해야 한다.</strong> 플래그가 0이면 매크로도 0이 되고, 지연 계산은 물론 VBlank 정보를 기록하는 코드까지 빌드에서 빠진다. 헷갈리기 쉬운 점이 하나 있다. 프레임 번호와 Present 카운터를 짝짓는 코드는 이 매크로 밖에 있어서 그대로 남는다. 그러니 코드가 보인다는 이유로 계측이 도는 줄 알면 안 된다. 플래그가 꺼진 플랫폼에서 입력 지연을 재려면 플랫폼 SDK의 프로파일러나 외부 계측 장비를 쓰는 편이 빠르다.
</p>

<p style="color:var(--text2);line-height:1.85;">
윈도우에서도 값이 0이면 행이 그려지지 않는다. 조건이 딱 하나다.
</p>

<div class="code-block"><span class="code-lang">C++, UnrealClient.cpp:528 (UE 5.8)</span><span class="kw">const bool</span> bHaveInputLatencyData = InputLatencyTime > <span class="num">0</span>;</div>

<p style="color:var(--text2);line-height:1.85;">
값이 한 번도 계산되지 않는 경우는 대개 VBlank 정보를 못 받는 상황이다. 추적 스레드는 D3D12, D3D11 뷰포트가 스왑체인을 만들 때 함께 생성된다. 이 스레드가 <code>GetFrameStatistics</code>에서 쓸 만한 <code>PresentCount</code>를 못 받으면 짝이 하나도 성립하지 않는다. 이 함수는 화면에 그림을 내보내는 방식에 따라 결과가 달라진다. 창 모드에서 윈도우 합성기를 거치는 경로, 스왑체인이 여러 개인 상황, 에디터 뷰포트처럼 백버퍼를 직접 Present하지 않는 경로에서 값이 안 잡히거나 엉뚱하게 나올 수 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 실패 조건은 짐작이 아니라 마이크로소프트 문서에 그대로 적혀 있다. <strong><code>GetFrameStatistics</code>는 창 모드에서 blt 모델(프레임을 복사해 내보내는 옛 방식)을 쓰는 스왑체인에는 쓸 수 없고</strong>, 그 경우 구조체의 모든 값이 0으로 돌아온다. 첫 호출과 모드 전환 직후에는 <code>DXGI_ERROR_FRAME_STATISTICS_DISJOINT</code>를 반환하고, <strong>다중 모니터 환경이나 다른 전체화면 앱이 함께 도는 상황에서는 통계를 신뢰할 수 없다</strong>고도 적혀 있다. 하드웨어 플립 큐를 지원하는 시스템에서는 통계가 갱신되기 전에 <code>DwmFlush</code>가 필요할 수 있다는 주의까지 붙는다. 즉 이 계측이 흔들리는 원인은 엔진이 아니라 <strong>화면에 그림을 내보내는 경로에 있다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
같은 문서에 <code>SyncQPCTime</code>의 의미도 나와 있다. 이 값은 <code>QueryPerformanceCounter</code>와 같은 기준으로 읽은 시간이고, 문서는 이를 <strong>"해당 VBlank 구간에 대응하는 시점"</strong>이라고 설명한다. 03장에서 이 값을 끝점으로 고른 것이 맞는 선택인 이유다. 문서는 이 필드를 "오디오, 비디오 동기나 아주 정밀한 애니메이션"에 쓰라고 권하는데, 입력 지연 계측이 정확히 그 용도에 해당한다.
</p>

<div class="data-table">
<table>
<tr><th>상황</th><th>Input 행</th><th>이유</th></tr>
<tr><td>윈도우 Development, Debug 게임</td><td>보인다</td><td>매크로 두 조건 모두 만족</td></tr>
<tr><td>윈도우 Test</td><td>평균은 보이고 Max는 안 나온다</td><td>Max 계산 블록만 <code>UE_BUILD_TEST</code>에서도 제외</td></tr>
<tr><td>윈도우 Shipping</td><td>없다</td><td><code>UE_INPUT_LATENCY_TRACKING</code>이 0</td></tr>
<tr><td>플립 추적(프레임이 화면에 걸린 시점을 알아내는 기능)을 지원하지 않는 플랫폼</td><td>없다</td><td>플랫폼 헤더가 <code>PLATFORM_SUPPORTS_FLIP_TRACKING</code>을 1로 덮어쓰지 않음</td></tr>
<tr><td>에디터 안에서 실행(PIE)</td><td>보통 안 나온다</td><td>에디터 뷰포트 Present 경로에서 스왑체인 통계 짝이 성립하지 않는 경우가 많다</td></tr>
<tr><td>값이 안 바뀌고 멈춰 있다</td><td>보인다(직전 값)</td><td>짝을 못 찾아 새 값을 못 쓰는 상태. 창 모드나 스왑체인 여러 개를 의심</td></tr>
</table>
</div>

<div class="callout callout-gold">
<div class="callout-title">먼저 확인할 것</div>
<p>입력 지연을 잴 때는 <strong>Development 빌드를 전체화면으로 띄우고</strong> 재는 것이 기본이다. 창 모드에서는 계측이 아예 실패하거나, 성공해도 윈도우 합성기가 더한 지연이 측정 밖에 남아 해석이 어려워진다. Shipping에서 이 값을 보려면 매크로를 프로젝트 쪽에서 강제로 켜는 엔진 수정이 필요하다는 것도 알아 두면 좋다.</p>
</div>
</div>

<div class="research-post">
<span class="section-eyebrow">07. 변경 이력</span>
</div>

# 5.7에서 5.8로 오며 새로 짠 부분

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
이 기능이 어떤 과정을 거쳐 지금 형태가 됐는지 보면 구조가 이해된다. 처음 들어온 것은 2019년 UE 4.23이다. 커밋 메시지가 성격을 그대로 요약한다. <strong>"Add support tracking for approximate input latency time on platforms that support flip tracking."</strong> 대략적이라는 뜻의 approximate가 처음부터 들어 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그런데 커뮤니티에서는 이 행을 <strong>5.5에서 새로 생긴 것</strong>이라고 이야기한다. 둘 다 맞다. 계측 코드는 4.23부터 있었지만, 커밋 제목 뒷부분에 적힌 조건에 막혀 있었다. <em>플립 추적을 지원하는 플랫폼에서만</em> 동작한다는 조건이다. 플립 추적은 프레임이 실제로 화면에 걸린 시점을 알아내는 기능이고, 03장에서 본 전용 스레드가 그 일을 한다. 윈도우 플랫폼 헤더가 그 플래그를 1로 켠 커밋은 <strong>2024년 7월</strong>이고, 이 변경이 처음 실린 릴리스가 5.5다. 그 커밋 제목이 내용을 다 설명한다. <strong>"Input latency stat computation enabled for DX11/DX12 using IDXGISwapChain::GetFrameStatistics and correlate the input reading timestamp to when the frame is handed to the display."</strong> 그래서 PC 개발자 입장에서는 이 행이 5.5에 등장한 것이 맞고, 그때 붙은 구현이 03장에서 본 DXGI 경로다.
</p>

<p style="color:var(--text2);line-height:1.85;">
5.5에서 5.7까지는 계산에 값을 넘기는 쪽 구조가 지금과 달랐다. 시작점이 마커가 아니라 <code>GInputTime</code> 전역이었고, 그 값을 렌더 커맨드에 실어 보내 <code>RHISetFrameDebugInfo</code>라는 함수에 넘겼다. 함수 이름 그대로 <strong>디버그 정보를 넘기는 경로에 같이 실려 가던 계측</strong>이었다.
</p>

<div class="code-block"><span class="code-lang">C++, RenderingThread.cpp (UE 5.7.0, 5.8에서 삭제됨)</span><span class="cm">// Set the FrameDebugInfo on platforms that have accurate frame tracking.</span>
<span class="fn">ENQUEUE_RENDER_COMMAND</span>(FrameDebugInfo)(
	[CurrentFrameCounter = GFrameCounter, CurrentInputTime = <span class="hl">GInputTime</span>](FRHICommandListImmediate&amp; RHICmdList)
{
	RHICmdList.<span class="fn">EnqueueLambda</span>([CurrentFrameCounter, CurrentInputTime](FRHICommandListImmediate&amp;)
	{
		<span class="cm">// Set the FrameCount and InputTime for input latency stats and flip debugging.</span>
		<span class="fn">RHISetFrameDebugInfo</span>(GRHIPresentCounter - <span class="num">1</span>, CurrentFrameCounter, CurrentInputTime);
	});
});</div>

<p style="color:var(--text2);line-height:1.85;">
문제는 <code>GRHIPresentCounter - 1</code>이라는 부분이다. Present 카운터를 <em>추측</em>해서 맞춰야 했다. 이 카운터가 언제 증가하는지는 플랫폼마다 달라서, 5.7 코드에는 그 차이를 설명하는 주석까지 붙어 있었다. 짝이 어긋나면 지연 값이 한 프레임씩 틀리거나 아예 계산되지 않는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
2026년 2월 커밋이 이 부분을 정리했다. 제목에 목적이 그대로 적혀 있다. <strong>"Change of how we correlate FrameCounter to PresentCounter in order to have more robust Input Latency computation on all supported Platforms."</strong> 여덟 파일에 걸쳐 219줄이 추가되고 135줄이 지워졌다.
</p>

<div class="data-table">
<table>
<tr><th>항목</th><th>UE 5.7까지</th><th>UE 5.8</th></tr>
<tr><td>시작 시간을 담는 곳</td><td><code>GInputTime</code> 전역(입력 샘플 델리게이트가 갱신)</td><td>프레임 번호를 키로 하는 <code>InputCycle</code> 자리</td></tr>
<tr><td>기록 주체</td><td>렌더 커맨드가 값을 실어 RHI로 전달</td><td>게임 스레드가 <code>SetInputSampleLatencyMarker</code>로 직접</td></tr>
<tr><td>Present 대응</td><td><code>GRHIPresentCounter - 1</code>을 추측</td><td>플랫폼 뷰포트가 Present 직전에 실제 짝을 기록</td></tr>
<tr><td>보관 구조</td><td><code>FrameDebugInfos</code> 배열 선형 탐색</td><td><code>FRHIFrameInfo</code> 맵 + 16프레임 Trim</td></tr>
<tr><td>VBlank timestamp</td><td>초 단위 값에서 사이클로 환산</td><td><code>VBlankTimeInCycles</code>(<code>SyncQPCTime</code>) 우선, 없으면 환산</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
그래서 <strong>5.8 이전 프로젝트에서 이 값을 보고 있었다면 지금 값과 그대로 비교하지 않는 편이 안전하다.</strong> 5.7 이하에서 한 프레임 어긋난 짝이 섞여 있었다면 16.67ms씩 한쪽으로 치우친 오차가 있을 수 있다. 엔진을 올린 전후로 Input 값이 한 프레임쯤 달라졌다면, 게임이 느려진 것이 아니라 계측이 정확해진 것일 가능성을 먼저 봐야 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
5.8에서는 같은 마커가 Unreal Insights 쪽으로도 나간다. <code>r.VsyncInformationInsights</code>를 1이나 2로 켜면 입력을 읽은 시점과 화면에 표시되기 시작한 시점이 타임라인에 북마크로 찍힌다. 2로 켜면 Present 카운터와 프레임 번호, 지연 값까지 함께 들어간다. 놓친 VBlank는 별도 문자열로 표시된다. 평균값 하나로는 안 보이는 프레임별 패턴을 볼 수 있는 유일한 수단이다.
</p>

<div class="code-block"><span class="code-lang">C++, RHIUtilities.cpp (UE 5.8, Insights 북마크)</span><span class="kw">else if</span> (GVsyncInformationInsights == <span class="num">2</span>)
{
	<span class="hl">TRACE_BOOKMARK_CYCLES</span>(Elem.Value.InputCycle,
		<span class="str">TEXT("Input P:%llu F:%llu")</span>, Elem.Value.PresentCounter, LatestFrameCounter)

	<span class="kw">if</span> (Hz)
	{
		<span class="hl">TRACE_BOOKMARK_CYCLES</span>(VBlankTimeInCycle,
			<span class="str">TEXT("Vsync (%.2f Hz) P:%llu F:%llu Lat:%.2f")</span>,
			Hz, Elem.Value.PresentCounter, LatestFrameCounter, Elem.Value.InputLatencyMS)
	}
}</div>
</div>

<div class="research-post">
<span class="section-eyebrow">08. 구조</span>
</div>

# 지연은 어디서 생기나: 스레드 겹침과 Present 큐

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
40ms라는 숫자를 봤으면 다음 질문은 그 40ms가 어디서 생기느냐다. 대부분은 <strong>스레드를 겹쳐 돌리는 구조와 Present 큐</strong>에 있다. 이 둘은 프레임 레이트를 올리려고 있는 장치이고, 그 대가로 내는 것이 입력 지연이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
언리얼의 기본 구성에서는 한 프레임의 일이 여러 스레드에 겹쳐서 돈다. 공장의 조립 라인과 같다. 게임 스레드가 프레임 N의 게임 로직을 계산하는 동안, 렌더 스레드는 한 프레임 전인 N-1의 그릴 목록을 만들고, RHI 스레드는 그보다 앞선 프레임의 명령을 GPU에 넘기고(Submit), GPU는 또 그 앞 프레임을 실제로 그린다. 각 스레드가 앞 단계를 기다리지 않고 자기 일을 계속하니 프레임 레이트는 올라간다. 대신 <strong>입력 하나가 화면에 닿기까지 거쳐야 하는 단계가 늘어난다.</strong> 라인이 길수록 한 시간에 만드는 개수는 늘지만, 물건 하나가 끝까지 가는 시간도 늘어나는 것과 같다. 몇 프레임까지 겹칠지를 정하는 것이 프레임 종료 동기화 코드다. 관련 콘솔 변수가 둘 있다.
</p>

<div class="code-block"><span class="code-lang">C++, RenderingThread.cpp:2435 (UE 5.8, cvar 선언)</span><span class="fn">TAutoConsoleVariable</span>&lt;<span class="kw">int32</span>&gt; CVarAllowOneFrameThreadLag(
	<span class="str">TEXT("r.OneFrameThreadLag")</span>,
	<span class="num">1</span>,
	<span class="str">TEXT("Whether to allow the rendering thread to lag one frame behind the game thread (0: disabled, otherwise enabled)")</span>
);

<span class="fn">TAutoConsoleVariable</span>&lt;<span class="kw">int32</span>&gt; CVarGTSyncType(
	<span class="str">TEXT("r.GTSyncType")</span>,
	<span class="num">0</span>,
	<span class="str">TEXT("Determines how the game thread syncs with the render thread, RHI thread and GPU.\n")</span>
	<span class="str">TEXT("Syncing to the GPU swap chain flip allows for lower frame latency.\n")</span>
	<span class="str">TEXT(" &lt;= 0 - Sync the game thread with the N-1 render thread frame. Then sync with the N-m RHI thread frame where m is (2 + (-r.GTSyncType)) ...\n")</span>
	<span class="str">TEXT("    1 - Sync the game thread with the N-1 RHI thread frame.\n")</span>
	<span class="str">TEXT("    2 - Sync the game thread with the GPU swap chain flip (only on supported platforms).\n")</span>,
	ECVF_Default
);</div>

<p style="color:var(--text2);line-height:1.85;">
<code>r.OneFrameThreadLag</code>는 렌더 스레드가 게임 스레드보다 한 프레임 뒤처져 돌아도 되는지를 정하는 스위치다. <code>r.GTSyncType</code>은 게임 스레드가 RHI 스레드나 화면 교체와 몇 프레임 간격으로 맞춰 갈지를 정한다. 도움말의 두 번째 줄이 이 글의 주제와 바로 이어진다. <strong>"Syncing to the GPU swap chain flip allows for lower frame latency."</strong> 화면 교체에 맞춰 동기화하면 지연이 줄어든다는 뜻이다. 실제 동기화 코드를 보면 각 모드가 무엇을 포기하는지 숫자로 나온다.
</p>

<div class="code-block"><span class="code-lang">C++, RenderingThread.cpp (UE 5.8, FFrameEndSync::Sync 발췌)</span><span class="cm">// The "r.OneFrameThreadLag" cvar forces a full sync, meaning the game thread will</span>
<span class="cm">// not start work until all the rendering work for the previous frame has completed.</span>
bFullSync |= CVarAllowOneFrameThreadLag.<span class="fn">GetValueOnAnyThread</span>() &lt;= <span class="num">0</span>;
...
<span class="kw">else if</span> (GTSyncType >= <span class="num">2</span>)
{
	SyncDepth = ESyncDepth::<span class="hl">Swapchain</span>;
	NumFramesOverlap = <span class="num">1</span>;
}
<span class="kw">else if</span> (GTSyncType == <span class="num">1</span>)
{
	SyncDepth = ESyncDepth::RHIThread;
	NumFramesOverlap = <span class="num">1</span>;
}
<span class="kw">else</span>
{
	<span class="cm">// Modes &lt;= 0 allows N frames of overlap with the RHI thread.</span>
	SyncDepth = ESyncDepth::RHIThread;
	NumFramesOverlap = <span class="num">2</span> + (-GTSyncType);
}</div>

<p style="color:var(--text2);line-height:1.85;">
기본값 0에서 <code>NumFramesOverlap</code>이 <strong>2</strong>다. 게임 스레드가 RHI 스레드보다 두 프레임 앞서 나갈 수 있다는 뜻이고, 그 두 프레임이 그대로 지연이 된다. 1로 올리면 겹침이 한 프레임으로 줄고, 2로 올리면 게임 스레드가 <strong>버퍼 교체 자체를 기다린다.</strong> 이 글에서는 이 마지막 모드를 플립 동기 모드라고 부른다. 지연은 가장 짧아진다. 대신 프레임 간격이 모니터 주사에 완전히 묶여서, GPU가 한 번 늦으면 그 늦어진 시간이 게임 스레드로 곧바로 넘어온다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="스레드를 겹쳐 돌리는 구조가 입력 지연을 만드는 방식">
<rect x="8" y="8" width="764" height="314" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="26" y="34" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#171a26">프레임 N의 입력이 화면에 닿기까지 (기본 구성)</text>

<line x1="120" y1="52" x2="740" y2="52" stroke="#c3c9d6" stroke-width="1"/>
<g font-family="Consolas, monospace" font-size="10" fill="#9aa3b5">
<text x="118" y="46">t</text>
<text x="180" y="46">+16.7ms</text>
<text x="304" y="46">+33.3ms</text>
<text x="428" y="46">+50.0ms</text>
<text x="552" y="46">+66.7ms</text>
</g>
<g stroke="#e3e8f0" stroke-width="1">
<line x1="200" y1="52" x2="200" y2="252"/>
<line x1="324" y1="52" x2="324" y2="252"/>
<line x1="448" y1="52" x2="448" y2="252"/>
<line x1="572" y1="52" x2="572" y2="252"/>
</g>

<g font-family="Segoe UI, sans-serif" font-size="11.5" font-weight="700" fill="#414455">
<text x="26" y="80">Game</text>
<text x="26" y="118">Render</text>
<text x="26" y="156">RHI</text>
<text x="26" y="194">GPU</text>
<text x="26" y="232">Display</text>
</g>

<rect x="120" y="64" width="76" height="22" rx="4" fill="#e8e6fb" stroke="#4338ca" stroke-width="1.6"/>
<text x="132" y="79" font-family="Consolas, monospace" font-size="10.5" fill="#4338ca">Game N</text>
<rect x="200" y="64" width="76" height="22" rx="4" fill="#f5f6fa" stroke="#c3c9d6" stroke-width="1"/>
<text x="208" y="79" font-family="Consolas, monospace" font-size="10.5" fill="#9aa3b5">Game N+1</text>

<line x1="120" y1="58" x2="120" y2="248" stroke="#b45309" stroke-width="2" stroke-dasharray="3 2"/>
<circle cx="120" cy="75" r="4.5" fill="#b45309"/>
<text x="96" y="302" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#b45309">입력 마커</text>

<rect x="200" y="102" width="76" height="22" rx="4" fill="#dbe7f6" stroke="#3b82c4" stroke-width="1.6"/>
<text x="208" y="117" font-family="Consolas, monospace" font-size="10.5" fill="#2a6da8">Render N</text>

<rect x="276" y="140" width="72" height="22" rx="4" fill="#dff3ee" stroke="#0a8f72" stroke-width="1.6"/>
<text x="292" y="155" font-family="Consolas, monospace" font-size="10.5" fill="#0a8f72">RHI N</text>

<rect x="324" y="178" width="100" height="22" rx="4" fill="#fdeee2" stroke="#c85a00" stroke-width="1.6"/>
<text x="344" y="193" font-family="Consolas, monospace" font-size="10.5" fill="#c85a00">GPU N</text>

<rect x="424" y="178" width="148" height="22" rx="4" fill="#fbeaee" stroke="#d6304a" stroke-width="1.4" stroke-dasharray="4 3"/>
<text x="436" y="193" font-family="Consolas, monospace" font-size="10.5" fill="#d6304a">Present 큐, VSync 대기</text>

<rect x="572" y="216" width="80" height="22" rx="4" fill="#eefaf6" stroke="#0a8f72" stroke-width="2"/>
<text x="582" y="231" font-family="Consolas, monospace" font-size="10.5" fill="#0a8f72">VBlank N</text>

<line x1="120" y1="266" x2="572" y2="266" stroke="#0a8f72" stroke-width="2"/>
<line x1="120" y1="259" x2="120" y2="273" stroke="#0a8f72" stroke-width="2"/>
<line x1="572" y1="259" x2="572" y2="273" stroke="#0a8f72" stroke-width="2"/>
<text x="200" y="285" font-family="Consolas, monospace" font-size="11.5" font-weight="700" fill="#0a8f72">stat unit Input</text>

<text x="330" y="302" font-family="Segoe UI, sans-serif" font-size="11" fill="#7e8295">각 스레드가 한 단계씩 뒤로 밀리고, 마지막에 수직동기까지 기다린다</text>
<text x="330" y="318" font-family="Segoe UI, sans-serif" font-size="11" fill="#7e8295">단계를 걷어내면 지연이 줄고, 대가는 프레임이 한 번 늦어도 버티는 힘이다</text>
</svg>
<div class="scene-cap">기본 구성에서 한 프레임의 일이 스레드를 타고 흐르는 모양. 각 단계가 한 프레임씩 뒤로 밀리므로 지연은 단계 수에 비례한다. 칸의 길이는 도식이고, 실제 값은 프로젝트마다 다르다.</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
플립 동기 모드에는 조건이 하나 붙는다. VSync가 꺼져 있으면 이 모드는 의미가 없어서, 별 알림 없이 RHI 동기 모드로 내려간다.
</p>

<div class="code-block"><span class="code-lang">C++, RenderingThread.cpp (UE 5.8)</span><span class="kw">if</span> (SyncDepth == ESyncDepth::Swapchain)
{
	<span class="cm">// Swapchain sync mode does not work when vsync is disabled. Fallback to RHI thread sync in that case.</span>
	<span class="kw">static auto</span> CVarVsync = IConsoleManager::<span class="fn">Get</span>().<span class="fn">FindConsoleVariable</span>(<span class="str">TEXT("r.VSync")</span>);
	...
	<span class="kw">if</span> (CVarVsync-><span class="fn">GetInt</span>() == <span class="num">0</span>)
	{
		SyncDepth = ESyncDepth::RHIThread;
	}
}</div>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">그런데 윈도우에서 <code>r.GTSyncType 2</code>는 아무 일도 하지 않는다</h2>

<p style="color:var(--text2);line-height:1.85;">
문서에 이 모드가 지연이 가장 낮다고 적혀 있으니 제일 먼저 켜 보고 싶어진다. 그런데 켜도 Input 값이 안 변한다. 이유가 소스에 주석까지 달려 있다. 이 모드가 하는 일은 "Present M이 화면에 표시되면 이 대기를 풀어 달라"고 등록하는 것이다. 그런데 그 등록을 처리해 줄 스레드가 없으면 <strong>등록한 대기를 곧바로 풀어 버린다.</strong>
</p>

<div class="code-block"><span class="code-lang">C++, RHIUtilities.cpp:465 (UE 5.8)</span><span class="kw">void</span> FRHIFrameFlipTrackingRunnable::<span class="fn">TriggerTaskEventOnFlip</span>(<span class="kw">uint64</span> PresentIndex, UE::Tasks::FTaskEvent Event)
{
	...
	<span class="kw">if</span> (Thread)
	{
		Singleton.FramePairs.<span class="fn">Emplace</span>(PresentIndex, <span class="fn">MoveTemp</span>(Event));
		...
	}
	<span class="kw">else</span>
	{
		<span class="cm">// Platform does not support flip tracking.</span>
		<span class="cm">// Signal the event now...</span>
		<span class="hl">Event.Trigger</span>();
	}
}</div>

<p style="color:var(--text2);line-height:1.85;">
그 스레드는 <code>RHIInitializeFlipTracking()</code>이 만든다. 5.8 트리에서 이 함수를 호출하는 곳은 <strong>일부 플랫폼의 뷰포트 초기화 코드뿐이고, 윈도우 D3D12, D3D11 경로에는 호출이 없다.</strong> D3D12 모듈은 종료할 때 <code>RHIShutdownFlipTracking()</code>만 부르는데, 초기화가 안 됐으면 그 함수도 바로 반환한다. 게다가 실제로 교체를 기다리는 함수(<code>RHIWaitForFlip</code>)는 기본 구현이 빈 구조체를 돌려주는 가상 함수이고, 윈도우 RHI는 이를 재정의하지 않는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
정리하면 이렇다. <strong>윈도우에서 <code>r.GTSyncType 2</code>는 버퍼 교체를 기다리는 대기를 하나 추가하지만, 그 대기가 곧바로 풀려서 결국 RHI 스레드 대기만 남는다.</strong> 모드 1과 똑같이 동작한다는 뜻이다. Epic 직원이 포럼에서 "모드 2는 일부 콘솔에서만 동작하고 PC에서는 모드 1과 같다"고 답한 근거가 이 코드다. PC에서 지연을 줄이려면 모드 2를 찾기보다 <strong>모드 1과 <code>r.OneFrameThreadLag</code>, 그리고 Present 큐 쪽</strong>을 봐야 한다.
</p>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">대가를 도움말에 그대로 적어 둔 콘솔 변수</h2>

<p style="color:var(--text2);line-height:1.85;">
이 교환 관계를 도움말에 그대로 써 둔 변수가 하나 있다. 언리얼 콘솔 변수 중에 대가를 이렇게까지 밝혀 둔 것은 흔치 않다.
</p>

<div class="code-block"><span class="code-lang">C++, RHIUtilities.cpp:131 (UE 5.8)</span><span class="fn">TAutoConsoleVariable</span>&lt;<span class="kw">float</span>&gt; CVarRHISyncSlackMS(
	<span class="str">TEXT("rhi.SyncSlackMS")</span>,
	<span class="num">10</span>,
	<span class="str">TEXT("Increases input latency by this many milliseconds, to help performance (trade-off tunable). Gamethread will be kicked off this many milliseconds before the vsync")</span>,
	ECVF_Default
);</div>

<p style="color:var(--text2);line-height:1.85;">
<strong>"입력 지연을 이만큼 늘려서 성능을 돕는다."</strong> 기본값이 10ms다. 게임 스레드를 VBlank보다 10ms 앞서 깨워 작업할 여유를 주는 설정이고, 그 여유가 그대로 지연이 된다. 값을 줄이면 지연이 줄고 대신 프레임을 놓칠 확률이 올라간다. 플립 동기 모드를 쓸 때 함께 맞추는 값이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
Epic의 공식 문서도 같은 말을 한다. 히칭은 어떤 프레임 하나가 갑자기 오래 걸리는 현상이다. <strong>"이 값을 줄이면 엔진 파이프라인이 짧아지는 대가로 입력 지연이 줄고, 히칭이 프레임 드롭으로 이어지기 쉬워진다. 반대로 늘리면 파이프라인이 길어져 히칭에 강해지지만 입력 지연이 늘어난다."</strong> 문서에는 30Hz 게임을 예로 든 숫자도 함께 있다. 기본 구성에서 최악의 입력 지연이 <strong>최대 130ms</strong>까지 갈 수 있다. 플립 동기 모드에서 여유를 0으로 두면 가장 좋을 때 <strong>약 66ms</strong>, 즉 30Hz 두 프레임이고, 여유를 기본값 10ms로 두면 <strong>약 76ms</strong>다.
</p>

<div class="callout callout-purple">
<div class="callout-title">이 숫자들을 읽는 법</div>
<p>130ms와 66ms의 차이는 렌더링을 빠르게 해서 얻은 것이 아니다. <strong>파이프라인 단계를 걷어내서 얻은 것이다.</strong> GPU 시간도, 드로우 콜 수도, 셰이더 복잡도도 그대로다. 그래서 입력 지연 작업은 성능 최적화와 성격이 다르다. 성능 최적화는 해야 할 일의 양을 줄이는 작업이다. 지연 최적화는 <strong>일의 순서와 겹침을 바꿔서 확보해 둔 여유를 되돌려주는 작업</strong>이다. 되돌려준 여유만큼 프레임을 놓칠 위험이 올라간다. 이 작업은 그 교환이 전부다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
Present 큐도 성격이 같다. 윈도우 D3D12 스왑체인은 백버퍼를 3개 만들고(<code>D3D12RHI_DEFAULT_NUM_BACKBUFFER 3</code>) 플립 모델로 Present한다. 플립 모델은 프레임을 복사하지 않고 버퍼 자체를 바꿔 끼워 내보내는 방식이다. 큐가 깊으면 GPU 시간이 들쭉날쭉해도 흡수되어 프레임이 매끄러워진다. 대신 다 그려진 프레임이 화면에 표시되기 시작할 때까지 큐에서 기다리는 시간이 늘어난다. VSync가 꺼져 있고 전체화면이 아니면 티어링 허용 플래그를 붙여 이 큐 대기를 건너뛴다. 티어링은 화면 위아래가 서로 다른 프레임으로 그려져 이음선이 보이는 현상이다.
</p>

<div class="code-block"><span class="code-lang">C++, WindowsD3D12Viewport.cpp:381 (UE 5.8)</span><span class="kw">if</span>(!SyncInterval &amp;&amp; !bIsFullscreen &amp;&amp; bAllowTearing)
{
	Flags |= <span class="hl">DXGI_PRESENT_ALLOW_TEARING</span>;
}
...
PresentHR = SwapChain1-><span class="fn">Present</span>(SyncInterval, Flags);</div>

<p style="color:var(--text2);line-height:1.85;">
GPU 작업이 끝나기를 어디서 기다릴지 정하는 변수도 있다. 이름은 프레임 완료지만, 실제로는 지연과 프레임 레이트를 맞바꾸는 스위치다.
</p>

<div class="code-block"><span class="code-lang">C++, ConsoleManager.cpp:4353 (UE 5.8)</span><span class="str">TEXT("r.FinishCurrentFrame")</span>,
<span class="num">0</span>,
<span class="str">TEXT(" 0: Wait for previous frame to be Finished on the GPU.(default)\n"</span>
	<span class="str">"-1: Do no wait for GPU.\n"</span>
	<span class="str">" 1: Wait for current frame to be Finished on the GPU.")</span>,</div>

<p style="color:var(--text2);line-height:1.85;">
D3D12 뷰포트가 이 값을 읽어 순서를 바꾼다. 1이면 Present 직후에 <strong>이번 프레임</strong>의 GPU 작업이 끝나기를 기다린다. 코드 주석에 목적이 그대로 적혀 있다. <em>"Finish current frame immediately to reduce latency."</em> CPU가 GPU보다 앞서 나가지 못하게 막아 큐를 얕게 유지하는 방식이고, 대가는 CPU와 GPU가 동시에 일하지 못한다는 것이다.
</p>

<div class="data-table">
<table>
<tr><th>변수</th><th>기본값</th><th>지연 방향</th><th>대가</th></tr>
<tr><td><code>r.OneFrameThreadLag</code></td><td>1</td><td>0으로 두면 감소</td><td>게임 스레드와 렌더 스레드가 동시에 일하지 못한다. CPU 프레임 시간이 두 스레드 시간의 합에 가까워진다</td></tr>
<tr><td><code>r.GTSyncType</code></td><td>0(2프레임 겹침)</td><td>1 → 감소, 2 → 최소</td><td>1은 RHI 스레드 겹침을 잃는다. 2는 버퍼 교체에 묶여 한 번 늦어진 프레임이 그대로 전달되고 VSync가 필수인데, <strong>윈도우에서는 아무 일도 하지 않아 1과 같다</strong></td></tr>
<tr><td><code>rhi.SyncSlackMS</code></td><td>10</td><td>줄이면 감소</td><td>도움말 그대로 성능 여유를 잃는다. 프레임 놓칠 확률 증가</td></tr>
<tr><td><code>rhi.SyncInterval</code></td><td>1</td><td>0이면 큐 대기 제거</td><td>티어링이 생기고 프레임 간격이 고르지 않게 된다</td></tr>
<tr><td><code>rhi.SyncAllowEarlyKick</code></td><td>1</td><td>유지가 유리</td><td>VBlank를 놓쳤을 때 다음 프레임을 일찍 시작해 따라잡는다</td></tr>
<tr><td><code>r.FinishCurrentFrame</code></td><td>0</td><td>1이면 감소</td><td>CPU와 GPU가 동시에 일하지 못한다. GPU가 병목이면 프레임 레이트가 바로 떨어진다</td></tr>
<tr><td><code>r.D3D12.NumViewportBuffers</code></td><td>3</td><td>줄이면 감소</td><td>프레임 시간이 흔들릴 때 받아 줄 여유가 없어진다. 실행 중에는 못 바꾸고 시작할 때 정해야 한다</td></tr>
<tr><td><code>t.MaxFPS</code>, 고정 프레임</td><td>0</td><td>상황에 따라 감소</td><td>GPU가 병목이 되지 않도록 상한을 두어 큐를 비우는 용도. 상한 자체는 지연을 늘릴 수도 있다</td></tr>
</table>
</div>

<div class="callout callout-warn">
<div class="callout-title">한 번에 다 켜면 안 되는 이유</div>
<p>위 변수들은 서로 같은 구간을 줄인다. <code>r.OneFrameThreadLag 0</code>과 <code>r.GTSyncType 1</code>을 함께 켜면 두 번째는 사실상 효과가 없다. 스레드를 겹치지 않는 상태에서는 코드가 겹침을 0으로 고정하기 때문이다. 그래서 <strong>한 번에 하나만 바꾸고 Input 값을 확인하는 방식</strong>이어야 결과를 해석할 수 있다. 여러 개를 한꺼번에 켜면 지연은 줄지만 어느 변수가 프레임 레이트를 떨어뜨렸는지 알 수 없다.</p>
<p>이 조합에는 실제로 엔진 버그가 있었다. 2025년 8월 Epic 포럼에 <code>r.VSync 1</code> + <code>r.GTSyncType 2</code> + <code>r.OneFrameThreadLag 0</code> 조합에서 두 번째 Present 이후 렌더가 멈추는 문제가 보고됐고, Epic이 재현해 수정을 메인에 넣었다. <strong>기본값에서 벗어난 동기 경로는 그만큼 실행된 적이 적은 코드</strong>라는 뜻이다. 엔진 버전을 올릴 때 이 설정 조합은 확인 목록에 넣어 두는 편이 좋다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
알아 둘 부수효과가 하나 있다. 플립 동기 모드와 VSync를 함께 쓰면 프레임 레이트를 계산하는 기준이 바뀐다. 게임 스레드 시간 대신 RHI 프레임 시간을 쓴다.
</p>

<div class="code-block"><span class="code-lang">C++, UnrealEngine.cpp:812 (UE 5.8, CalculateFPSTimings)</span><span class="kw">if</span> (CVarGTSyncType-><span class="fn">GetInt</span>() == <span class="num">2</span> &amp;&amp; CVarVsync-><span class="fn">GetInt</span>() != <span class="num">0</span>)
{
	<span class="kw">float</span> RHIFrameTime = <span class="fn">RHIGetFrameTime</span>();
	<span class="kw">if</span> (RHIFrameTime != <span class="num">0</span>)
	{
		FrameTimeMS = RHIFrameTime;
	}
}</div>

<p style="color:var(--text2);line-height:1.85;">
버퍼 교체에 묶인 상태에서는 게임 스레드의 간격이 실제로 화면이 바뀌는 간격과 다를 수 있어서, 더 정확한 쪽을 쓰는 것이다. 이 모드를 켠 뒤 프레임 레이트 숫자가 조금 달라졌다면 성능이 바뀐 것이 아니라 계측 기준이 바뀐 것이다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">09. 벤더 저지연 기술</span>
</div>

# 남는 시간을 입력을 읽기 전에 기다릴 것인가, 읽은 뒤에 기다릴 것인가

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
지연 문제를 한 문장으로 줄이면 이렇다. <strong>프레임 레이트를 제한하는 순간 어딘가에서는 남는 시간을 기다려야 하고, 그 대기를 입력을 읽기 전에 두면 지연이 안 늘고 읽은 뒤에 두면 그만큼 지연이 된다.</strong> 60fps에 맞추려면 한 프레임에 16.67ms를 다 쓰거나 남는 시간을 어디선가 흘려보내야 하는데, 그 위치가 지연을 정한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
프레임 리미터는 <code>t.MaxFPS</code> 같은 프레임 레이트 상한을 지키려고 남는 시간을 기다려 주는 코드다. 언리얼의 기본 프레임 리미터는 이미 좋은 자리에 있다. 틱 맨 앞에서 목표 프레임 시간이 될 때까지 <code>Sleep</code>으로 기다린다.
</p>

<div class="code-block"><span class="code-lang">C++, UnrealEngine.cpp:3060 (UE 5.8, UpdateTimeAndHandleMaxTickRate)</span><span class="cm">// Convert from max FPS to wait time.</span>
<span class="kw">if</span>( MaxTickRate > <span class="num">0</span> )
{
	WaitTime = FMath::<span class="fn">Max</span>( <span class="num">1.f</span> / MaxTickRate - DeltaRealTime, <span class="num">0.f</span> );
}
...
<span class="cm">// Sleep if we're waiting more than 5 ms. We set the scheduler granularity to 1 ms</span>
<span class="cm">// at startup on PC. We reserve 2 ms of slack time which we will wait for by giving</span>
<span class="cm">// up our timeslice.</span>
<span class="kw">if</span> (WaitTime > <span class="num">5</span> / <span class="num">1000.f</span>)
{
	FPlatformProcess::<span class="fn">SleepNoStats</span>(WaitTime - <span class="num">0.002f</span>);
}

<span class="cm">// Give up timeslice for remainder of wait time.</span>
<span class="kw">while</span> (FPlatformTime::<span class="fn">Seconds</span>() &lt; WaitEndTime)
{
	FPlatformProcess::<span class="fn">SleepNoStats</span>(<span class="num">0</span>);
}</div>

<p style="color:var(--text2);line-height:1.85;">
이 대기는 <strong>입력 마커보다 앞</strong>에 있다. 엔진 루프 순서로 프레임 리미터 → 시뮬레이션 시작 마커 → RHI 프레임 시작 → 입력 마커 → 메시지 펌프다. 그래서 <code>t.MaxFPS</code>로 프레임을 제한해도 그 대기 시간은 Input 값에 안 들어간다. 마지막 2ms를 <code>Sleep</code> 대신 CPU 양보로 채우는 것도 의도한 설계다. OS 스케줄러가 밀리초 단위로만 깨워 주기 때문에, <code>Sleep</code>에 맡기면 목표 시각을 넘겨서 깨어날 수 있다.
</p>

<p style="color:var(--text2);line-height:1.85;">
문제는 <strong>이 대기가 저절로 뒤쪽으로 옮겨 가는 경우</strong>다. GPU가 병목인 상태에서 VSync를 켜면 CPU는 계속 앞서 나가며 커맨드를 쌓고, 실제 대기는 Present 큐에서 일어난다. 그 자리는 입력을 읽은 뒤다. 그래서 프레임 레이트는 같은 60fps인데 지연만 두세 프레임 늘어난다. 그래픽 벤더의 저지연 기술은 정확히 이 대기를 옮긴다.
</p>

<div class="scene-fig">
<svg viewBox="0 0 780 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="기다림의 위치에 따른 입력 지연 차이">
<rect x="8" y="8" width="764" height="284" rx="10" fill="#ffffff" stroke="#d5dbe6"/>
<text x="26" y="34" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700" fill="#171a26">같은 60fps, 기다림의 위치만 다른 세 경우</text>

<g font-family="Segoe UI, sans-serif" font-size="11" fill="#7e8295">
<text x="26" y="62">① 프레임 상한</text>
<text x="26" y="76">CPU 여유 있음</text>
<text x="26" y="132">② GPU 병목</text>
<text x="26" y="146">VSync 켜짐</text>
<text x="26" y="202">③ 벤더 저지연</text>
<text x="26" y="216">드라이버가 깨움</text>
</g>

<!-- case 1 -->
<rect x="140" y="52" width="120" height="26" rx="4" fill="#eef0fa" stroke="#8b93c8" stroke-width="1.3" stroke-dasharray="4 3"/>
<text x="158" y="69" font-family="Consolas, monospace" font-size="10.5" fill="#6b72a8">Sleep (여유 반납)</text>
<circle cx="266" cy="65" r="4.5" fill="#b45309"/>
<rect x="274" y="52" width="150" height="26" rx="4" fill="#e8e6fb" stroke="#4338ca" stroke-width="1.5"/>
<text x="288" y="69" font-family="Consolas, monospace" font-size="10.5" fill="#4338ca">Game, Render, RHI</text>
<rect x="424" y="52" width="86" height="26" rx="4" fill="#fdeee2" stroke="#c85a00" stroke-width="1.5"/>
<text x="446" y="69" font-family="Consolas, monospace" font-size="10.5" fill="#c85a00">GPU</text>
<rect x="510" y="52" width="70" height="26" rx="4" fill="#eefaf6" stroke="#0a8f72" stroke-width="1.8"/>
<text x="522" y="69" font-family="Consolas, monospace" font-size="10.5" fill="#0a8f72">VBlank</text>
<line x1="266" y1="88" x2="580" y2="88" stroke="#0a8f72" stroke-width="2"/>
<line x1="266" y1="82" x2="266" y2="94" stroke="#0a8f72" stroke-width="2"/>
<line x1="580" y1="82" x2="580" y2="94" stroke="#0a8f72" stroke-width="2"/>
<text x="592" y="72" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#0a8f72">Input 짧음</text>
<text x="592" y="90" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#7e8295">기다림이 마커 앞</text>

<!-- case 2 -->
<circle cx="146" cy="135" r="4.5" fill="#b45309"/>
<rect x="154" y="122" width="150" height="26" rx="4" fill="#e8e6fb" stroke="#4338ca" stroke-width="1.5"/>
<text x="168" y="139" font-family="Consolas, monospace" font-size="10.5" fill="#4338ca">Game, Render, RHI</text>
<rect x="304" y="122" width="120" height="26" rx="4" fill="#fdeee2" stroke="#c85a00" stroke-width="1.5"/>
<text x="340" y="139" font-family="Consolas, monospace" font-size="10.5" fill="#c85a00">GPU (긴 편)</text>
<rect x="424" y="122" width="156" height="26" rx="4" fill="#fbeaee" stroke="#d6304a" stroke-width="1.4" stroke-dasharray="4 3"/>
<text x="436" y="139" font-family="Consolas, monospace" font-size="10.5" fill="#d6304a">Present 큐에서 대기</text>
<rect x="580" y="122" width="70" height="26" rx="4" fill="#eefaf6" stroke="#0a8f72" stroke-width="1.8"/>
<text x="592" y="139" font-family="Consolas, monospace" font-size="10.5" fill="#0a8f72">VBlank</text>
<line x1="146" y1="158" x2="650" y2="158" stroke="#d6304a" stroke-width="2"/>
<line x1="146" y1="152" x2="146" y2="164" stroke="#d6304a" stroke-width="2"/>
<line x1="650" y1="152" x2="650" y2="164" stroke="#d6304a" stroke-width="2"/>
<text x="662" y="142" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#d6304a">Input 길다</text>
<text x="656" y="160" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#7e8295">기다림이 뒤로</text>

<!-- case 3 -->
<rect x="140" y="192" width="120" height="26" rx="4" fill="#eef0fa" stroke="#8b93c8" stroke-width="1.3" stroke-dasharray="4 3"/>
<text x="150" y="209" font-family="Consolas, monospace" font-size="10.5" fill="#6b72a8">드라이버 Sleep</text>
<circle cx="266" cy="205" r="4.5" fill="#b45309"/>
<rect x="274" y="192" width="150" height="26" rx="4" fill="#e8e6fb" stroke="#4338ca" stroke-width="1.5"/>
<text x="288" y="209" font-family="Consolas, monospace" font-size="10.5" fill="#4338ca">Game, Render, RHI</text>
<rect x="424" y="192" width="120" height="26" rx="4" fill="#fdeee2" stroke="#c85a00" stroke-width="1.5"/>
<text x="460" y="209" font-family="Consolas, monospace" font-size="10.5" fill="#c85a00">GPU (긴 편)</text>
<rect x="544" y="192" width="70" height="26" rx="4" fill="#eefaf6" stroke="#0a8f72" stroke-width="1.8"/>
<text x="556" y="209" font-family="Consolas, monospace" font-size="10.5" fill="#0a8f72">VBlank</text>
<line x1="266" y1="228" x2="614" y2="228" stroke="#0a8f72" stroke-width="2"/>
<line x1="266" y1="222" x2="266" y2="234" stroke="#0a8f72" stroke-width="2"/>
<line x1="614" y1="222" x2="614" y2="234" stroke="#0a8f72" stroke-width="2"/>
<text x="626" y="212" font-family="Consolas, monospace" font-size="11" font-weight="700" fill="#0a8f72">Input 짧음</text>
<text x="626" y="230" font-family="Segoe UI, sans-serif" font-size="10.5" fill="#7e8295">큐를 비운 채 진입</text>

<rect x="26" y="248" width="726" height="1" fill="#e3e8f0"/>
<text x="26" y="270" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#414455">세 경우 모두 프레임 레이트는 60fps로 같다. GPU가 하는 일의 양도 ②와 ③이 같다.</text>
<text x="26" y="286" font-family="Segoe UI, sans-serif" font-size="11.5" fill="#414455">달라진 것은 <tspan font-weight="700">쉬는 시간이 입력 마커(●) 앞에 있는지 뒤에 있는지</tspan>뿐이다.</text>
</svg>
<div class="scene-cap">기다림의 위치가 지연을 정한다. ②는 CPU가 앞서 달려 Present 큐에 대기가 쌓인 상태, ③은 드라이버가 게임 스레드를 늦게 풀어 그 대기를 마커 앞으로 옮긴 상태다.</div>
</div>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">Reflex는 프레임 리미터를 대체한다</h2>

<p style="color:var(--text2);line-height:1.85;">
언리얼에는 NVIDIA Reflex 플러그인이 기본으로 들어 있다(<code>Engine/Plugins/Runtime/Nvidia/Reflex</code>). 이 플러그인이 하는 일은 두 가지다. 하나는 <strong>엔진의 프레임 리미터를 자기가 대신 처리하는 것</strong>이고, 다른 하나는 구간마다 마커를 찍어 드라이버에 넘기는 것이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
첫 번째가 핵심이다. 엔진의 프레임 리미터에는 외부 모듈이 끼어들 수 있는 지점이 마련되어 있다.
</p>

<div class="code-block"><span class="code-lang">C++, UnrealEngine.cpp:3067 (UE 5.8)</span><span class="kw">bool</span> bMaxTickRateHandled = <span class="kw">false</span>;
TArray&lt;IMaxTickRateHandlerModule*&gt; MaxTickRateHandlerModules = ...;

<span class="kw">for</span> (IMaxTickRateHandlerModule* MaxTickRateHandler : MaxTickRateHandlerModules)
{
	<span class="kw">if</span> (MaxTickRateHandler-><span class="fn">HandleMaxTickRate</span>(MaxTickRate))
	{
		bMaxTickRateHandled = <span class="kw">true</span>;
		<span class="kw">break</span>;
	}
}
...
<span class="kw">if</span> (!bMaxTickRateHandled)
{
	<span class="cm">// 엔진 자체 sleep. 핸들러가 처리했다면 이 블록을 건너뛴다</span>
}</div>

<p style="color:var(--text2);line-height:1.85;">
Reflex 플러그인이 이 자리에 들어가 <code>true</code>를 돌려주면 엔진은 자기 <code>Sleep</code>을 건너뛴다. 대신 플러그인이 드라이버가 제공하는 대기 함수를 호출한다.
</p>

<div class="code-block"><span class="code-lang">C++, ReflexMaxTickRateHandler.cpp (UE 5.8 번들 플러그인)</span>NV_SET_SLEEP_MODE_PARAMS_V1 params = { <span class="num">0</span> };
params.bLowLatencyMode      = bLowLatencyMode;
params.bLowLatencyBoost     = bBoost;
params.minimumIntervalUs    = MinimumInterval;   <span class="cm">// t.MaxFPS 를 마이크로초 간격으로 환산</span>
params.bUseMarkersToOptimize = DisableLatencyMarkerOptimize ? NV_FALSE : NV_TRUE;
status = <span class="fn">NvAPI_D3D_SetSleepMode</span>(FReflexModule::<span class="fn">GetD3DDevice</span>(), &amp;params);
...
{
	UE::Stats::FThreadIdleStats::FScopeIdle Scope;
	StatusSleep = <span class="hl">NvAPI_D3D_Sleep</span>(Unknown);
}

<span class="kw">return true</span>;   <span class="cm">// ← 엔진의 자체 sleep 을 무력화</span></div>

<p style="color:var(--text2);line-height:1.85;">
차이는 <strong>깨우는 시점을 누가 정하느냐</strong>다. 엔진은 목표 프레임 간격만 알고 기다린다. 드라이버는 GPU 큐에 무엇이 얼마나 쌓였는지까지 알고 있어서, 이 프레임의 GPU 작업이 제때 끝나도록 게임 스레드를 조금 늦게 풀어 준다. 그러면 Present 큐가 비어 있는 상태로 프레임이 들어가고, 뒤쪽에 있던 대기가 앞쪽으로 옮겨 온다. <code>bUseMarkersToOptimize</code> 플래그가 켜져 있는 이유도 이것이다. 드라이버가 구간별 마커를 보고 깨울 시점을 계산한다.
</p>

<div class="callout callout-gold">
<div class="callout-title">이 아이디어는 Reflex보다 10년 앞선다</div>
<p>마이크로소프트가 DXGI 1.3의 대기 가능 스왑체인(새 프레임을 받을 준비가 되면 알려 주는 스왑체인)을 소개한 문서에 같은 원인 분석과 같은 해법이 이미 나와 있다. 원인은 이렇게 적혀 있다. <strong>"많은 경우 시스템은 안정된 평형에 도달하는데, 게임이 프레임을 렌더한 시점과 그것을 표시하는 시점 사이에서 항상 거의 한 프레임을 더 기다리게 된다."</strong> 해법은 이렇다. <strong>"시스템이 새 프레임을 받을 준비가 될 때까지 기다린 다음, 현재 데이터로 프레임을 렌더해서 곧바로 큐에 넣는 것이 낫다."</strong></p>
<p>"현재 데이터로"라는 표현이 핵심이다. 기다린 <em>다음</em>에 입력을 읽으라는 뜻이고, 그게 이 장의 주제다. Reflex와 Anti-Lag 2가 하는 일은 이 방법을 게임 코드가 아니라 드라이버에서, GPU 큐 상태까지 보고 실행하는 것이다. 참고로 DXGI의 기본 최대 프레임 지연은 <strong>3프레임</strong>(1~16 범위)이고, 대기 가능 스왑체인의 기본값은 <strong>1</strong>이다. 이 기본값 차이가 곧 두 프레임어치 지연이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
마커는 엔진 루프의 여러 곳에서 드라이버로 보낸다. 02장에서 본 입력 마커 함수의 반복문이 이 경로다.
</p>

<div class="data-table">
<table>
<tr><th>마커</th><th>엔진 루프 위치</th><th>호출 지점</th></tr>
<tr><td>Simulation Start</td><td>프레임 리미터 직후</td><td><code>UpdateTimeAndHandleMaxTickRate</code> 다음 줄</td></tr>
<tr><td>Input Sample</td><td>메시지 펌프 직전</td><td><code>SetInputSampleLatencyMarker</code>(RHI 마커와 같은 자리)</td></tr>
<tr><td>Render Submit Start, End</td><td>렌더 스레드 프레임 경계</td><td>RHI 커맨드리스트 람다에서</td></tr>
<tr><td>Present Start, End</td><td>Present 직전, 직후</td><td>Slate가 뷰포트에 콜백으로 등록</td></tr>
<tr><td>Simulation End</td><td>RHI 틱 이후, 프레임 동기 이전</td><td>주석: "EndFrameRenderThread 큐잉 전에 설정해야 순서가 안 꼬인다"</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
플러그인은 드라이버에서 결과를 다시 읽어 구간별 지연을 만든다. 평균을 내는 방식이 주석에 적혀 있다.
</p>

<div class="code-block"><span class="code-lang">C++, ReflexLatencyMarkers.cpp (UE 5.8 번들 플러그인)</span><span class="cm">// frameReport[63] contains the latest completed frameReport</span>
<span class="kw">const</span> NvU64 TotalLatencyUs = LatencyResults.frameReport[<span class="num">63</span>].gpuRenderEndTime
                           - LatencyResults.frameReport[<span class="num">63</span>].simStartTime;
...
<span class="cm">// A 3/4, 1/4 split gets close to a simple 10 frame moving average</span>
AverageTotalLatencyMs = AverageTotalLatencyMs * <span class="num">0.75f</span> + TotalLatencyUs / <span class="num">1000.0f</span> * <span class="num">0.25f</span>;</div>

<div class="callout callout-warn">
<div class="callout-title">Reflex 숫자와 stat unit Input을 같은 표에 넣지 말 것</div>
<p>두 값이 재는 구간이 다르다. Reflex의 총 지연은 <strong>시뮬레이션 시작부터 GPU 렌더 종료까지</strong>이고, <code>stat unit</code>의 Input은 <strong>입력 마커부터 화면에 표시되기 시작할 때까지</strong>다. 시작점은 Reflex가 더 앞이고, 끝점은 Input이 더 뒤다. 그래서 어느 쪽도 다른 쪽을 포함하지 않는다. 특히 <strong>Present 큐 대기와 VBlank 대기는 Reflex의 총 지연에는 안 들어가고 Input에는 들어간다.</strong> VSync를 켠 상태에서 두 숫자가 한 프레임 이상 벌어지는 것은 정상이다. NVIDIA가 시스템 지연을 이야기할 때 present-to-displayed 구간을 따로 더하는 이유가 이것이다.</p>
</div>

<p style="color:var(--text2);line-height:1.85;">
다른 벤더도 구조가 같다. AMD의 Anti-Lag 2는 언리얼 플러그인을 제공하고 <code>r.AMD.AntiLag2</code>로 켜며, 문서에 <strong>"사용자 입력을 읽기 직전, 게임 로직 안의 가장 좋은 지점"</strong>에 넣는다고 설명한다. 인텔의 XeLL도 대기 함수 하나에 시뮬레이션, 렌더 Submit, Present 마커를 붙이는 같은 구조다. 세 벤더가 같은 구조가 된 것은 대기 위치를 앞으로 옮기는 것 말고 다른 해법이 없기 때문이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
한 걸음 더 나간 방법도 있다. NVIDIA가 2025년에 공개한 Reflex 2의 프레임 워프는 <strong>다 그려진 프레임을 화면에 내보내기 직전에, 더 최근에 읽은 입력으로 다시 투영한다.</strong> 엔진이 줄일 수 없는 구간, 즉 Input이 재는 구간의 뒷부분을 나중에 보정하는 방식이다. 시점이 움직이면 원래 가려져 있던 부분이 드러나므로 그 영역을 추정해 채워 넣는 처리가 따라붙는다. 그래서 이 기술은 카메라 회전처럼 시야가 바뀌는 경우에 효과가 있고, 게임 로직의 판정에는 관여하지 않는다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">10. 실무</span>
</div>

# 이 숫자를 실제로 쓰는 절차

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
정의를 알았으면 이제 도구로 쓸 수 있다. 실무에서 이 값을 쓰는 상황은 대개 셋이다. 어느 날 갑자기 지연이 늘었을 때 원인을 찾는 경우, 설정을 바꾼 대가가 몇 ms인지 확인하는 경우, 외부 장비로 잰 값을 구간별로 해석하는 경우다.
</p>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">측정 조건 고정</h2>

<p style="color:var(--text2);line-height:1.85;">
이 값은 측정 조건에 따라 쉽게 달라진다. 서로 비교할 수 있는 숫자를 얻으려면 아래를 고정하고 재야 한다. 하나라도 흔들리면 값이 프레임 단위로 움직인다.
</p>

<div class="data-table">
<table>
<tr><th>고정할 것</th><th>이유</th></tr>
<tr><td>Development 빌드, 전체화면</td><td>계측 자체가 Shipping에서 빠지고, 창 모드에서는 스왑체인 통계 짝이 실패할 수 있다</td></tr>
<tr><td>같은 장면, 같은 카메라</td><td>GPU 시간이 지연의 일부라서 장면이 바뀌면 값도 바뀐다</td></tr>
<tr><td>VSync, 프레임 상한, 해상도</td><td>Present 큐에서 얼마나 기다리는지, GPU가 병목인지를 직접 정한다</td></tr>
<tr><td>드라이버 저지연 설정</td><td>제어판의 저지연 모드가 켜져 있으면 엔진 변경 효과와 섞인다</td></tr>
<tr><td>동적 해상도, 업스케일러</td><td>GPU 시간이 알아서 변하니 두 설정을 비교할 수 없다. 끄거나 고정 배율로</td></tr>
<tr><td>측정 시간 3초 이상</td><td>평균이 다 반영되기까지 열 프레임, Max 구간이 200프레임이다</td></tr>
</table>
</div>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">읽는 순서</h2>

<div class="step-block s1">
<h4>① Input과 Frame을 함께 본다</h4>
<p>Input을 Frame으로 나누면 파이프라인이 몇 프레임 깊은지 나온다. 이 값이 2.5 근처면 기본 구성 그대로이고, 3.5를 넘으면 어딘가에서 큐가 더 쌓이고 있다는 신호다. 원인을 찾을 때는 절대값보다 이 비율이 쓸모 있다.</p>
</div>

<div class="step-block s2">
<h4>② GPU가 병목인지 먼저 판정한다</h4>
<p>GPU 행이 Frame과 거의 같으면 GPU가 병목이다. 이 상태에서는 동기화 관련 콘솔 변수를 만져도 효과가 작다. 대기가 Present 큐에 붙어 있어서 앞으로 옮겨 오지 않기 때문이다. <strong>먼저 할 일은 GPU 시간을 줄이거나 프레임 상한을 GPU가 감당할 수 있는 선 아래로 내리는 것</strong>이고, 콘솔 변수는 그다음이다.</p>
</div>

<div class="step-block s3">
<h4>③ 변수는 하나씩, 사이에 3초</h4>
<p>08장 표의 변수를 하나만 바꾸고 값을 읽는다. 여러 개를 함께 켜면 서로 효과를 없애거나 원인을 가린다. 값을 읽기 전에 3초 이상 두는 것은 화면 숫자가 평균이기 때문이다.</p>
</div>

<div class="step-block s4">
<h4>④ 프레임별 패턴은 Insights로</h4>
<p>평균값은 주기적으로 한 프레임씩 놓치는 현상을 가린다. <code>r.VsyncInformationInsights 2</code>로 켜면 입력을 읽은 시점과 화면에 표시되기 시작한 시점이 타임라인에 북마크로 찍히고, 놓친 VBlank도 따로 표시된다. "평균은 괜찮은데 가끔 답답하다"는 제보는 대부분 여기서 원인이 보인다.</p>
</div>

<div class="callout callout-teal">
<div class="callout-title">회귀를 잡는 데 특히 좋다</div>
<p>절대값은 해석이 까다롭지만 <strong>얼마나 변했는지는 믿을 수 있다.</strong> 같은 장면, 같은 빌드 설정에서 지난주보다 Input이 16ms 늘었다면 파이프라인에 프레임 하나가 더 생긴 것이다. 그런 변화는 렌더링 쪽보다 동기화나 큐 구조를 건드린 변경일 가능성이 높다. 스레드 겹침을 바꾼 커밋, 프레임 상한 로직, 업스케일러 도입, 엔진 버전 업이 후보다. 데일리 빌드에서 이 값을 CSV로 남겨 두면 지연이 늘어난 것과 프레임 시간이 늘어난 것을 갈라 볼 수 있다.</p>
</div>


<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">엔진 밖 숫자와 맞춰 보기</h2>

<p style="color:var(--text2);line-height:1.85;">
절대값이 필요할 때 쓸 수 있는 무료 도구가 있다. 인텔의 PresentMon 2.x는 윈도우 이벤트 추적 기능으로 프레임이 화면에 표시되기까지의 경로를 따라가며 지연 지표를 뽑아 준다. 각 지표가 무엇에서 무엇까지인지 문서에 적혀 있어서 해석이 분명하다.
</p>

<div class="data-table">
<table>
<tr><th>PresentMon 지표</th><th>정의(문서 표현)</th><th>Input과의 관계</th></tr>
<tr><td>Display Latency</td><td>프레임 Submit부터 화면에 표시되기 시작할 때까지</td><td>Input의 뒷부분과 겹친다. 시작점이 더 뒤라서 값이 더 짧다</td></tr>
<tr><td>Click To Photon</td><td>이 프레임에 반영된 가장 이른 마우스 클릭부터 그 프레임이 표시될 때까지</td><td><strong>Input이 못 재는 앞쪽 구간까지 포함한 실측값</strong></td></tr>
<tr><td>All Input To Photon</td><td>키보드, 마우스 입력 기준의 같은 값</td><td>같음. 클릭 외 입력까지</td></tr>
<tr><td>Instrumented Latency</td><td>드라이버 마커 기준, 프레임 시작부터 표시까지</td><td>Reflex 계열 마커가 있어야 나온다</td></tr>
<tr><td>Displayed Time</td><td>이 프레임이 화면에 머문 시간</td><td>프레임 간격이 고른지 볼 때 쓴다. 지연과는 별개</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
쓰는 방법은 이렇다. <strong>PresentMon의 Click To Photon과 <code>stat unit</code>의 Input을 같은 조건에서 함께 기록하고 차이를 본다.</strong> 그 차이가 05장 표에서 측정 밖이라고 표시한 구간의 합이다. 환경을 바꿔 가며 재면 어느 하드웨어가 몇 ms를 차지하는지 갈라 볼 수 있다. 다만 이 값은 마우스 클릭 기준이라, 패드 지연은 따로 재야 한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
장비를 쓸 수 있으면 더 확실하다. 화면 밝기 변화를 광센서로 잡는 방식(NVIDIA의 LDAT나 고속 카메라)은 <strong>버튼을 누른 순간부터 픽셀이 실제로 밝아질 때까지를 엔진과 무관하게</strong> 잰다. 이때 게임 쪽에서 준비할 것은 하나다. 입력이 들어오면 화면 한쪽을 밝게 칠해서 센서가 볼 수 있게 하는 것이다. 언리얼의 지연 마커 인터페이스에는 이 표시 전용 마커와 켜기, 끄기 함수가 이미 있어서, 계측용 코드를 새로 만들 필요는 없다.
</p>
<p style="color:var(--text2);line-height:1.85;">
반대로 이 값으로 하면 안 되는 일도 분명하다. <strong>스펙으로 인용하기, 다른 게임과 비교하기, 컨트롤러나 모니터가 다른 두 환경의 값을 나란히 놓기</strong>다. 05장 표에서 봤듯 빠진 구간이 환경마다 다르니, 그런 비교는 서로 다른 것을 재서 견주는 셈이 된다.
</p>
</div>

<div class="research-post">
<span class="section-eyebrow">11. 격투 게임</span>
</div>

# 격투 게임이 한 프레임을 줄이려고 포기하는 것들

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
여기까지는 계측과 구조였다. 이제 이 지식이 어떤 장르에서는 왜 사활이 걸린 문제가 되는지 보자. 격투 게임은 <strong>지연 자체가 게임 규칙</strong>인 장르다. 발동 3프레임 기술은 입력 후 3프레임에 판정이 서고, 패리는 그보다 더 좁은 구간에서만 성립한다. 게임 안의 프레임 데이터가 이렇게 촘촘한데 파이프라인이 4프레임을 차지하면, 플레이어가 상대하는 것은 게임의 프레임 데이터가 아니라 파이프라인이 된다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 이 장르는 지연을 ms가 아니라 <strong>프레임으로 센다.</strong> 60Hz에서 1프레임은 16.67ms다. 이 단위가 커뮤니티 표준이 된 것은 그것이 게임 규칙의 단위이기 때문이다. 커뮤니티가 쓰는 기준선도 프레임으로 적혀 있다. 입력 지연 데이터베이스를 오래 운영한 Adeel Soomro는 <strong>"게임과 모니터를 합쳐 4~5프레임 정도가 이상적"</strong>이라고 정리했고, 같은 데이터베이스의 등급 구간은 모니터를 포함한 값으로 4.2~4.8프레임을 최상, 6.0~6.5프레임을 보통, 7.3프레임 이상을 나쁨으로 나눈다. 04장에서 본 언리얼의 색 기준이 약 85ms까지 초록, 즉 5프레임이었다. 이 장르 기준으로는 이미 나쁨 등급이니 색을 보면 안 되는 이유가 여기서 분명해진다.
</p>

<div class="callout callout-purple">
<div class="callout-title">평균이 아니라 분산이 체감을 정한다</div>
<p>이 분야의 계측자들은 평균 말고 하나를 더 잰다. Loïc Petit이 정의한 <strong>stability</strong>는 프레임 안의 같은 타이밍에 입력했을 때 같은 지연이 다시 나올 확률이다. 스트리트 파이터 5의 옛 버전은 평균만 보면 5.5프레임이었는데 이 값이 <strong>38%</strong>였다. 같은 타이밍에 같은 입력을 넣어도 지연이 매번 달랐다는 뜻이다. 패치 후에는 평균 4.4프레임에 stability 77%가 되었다. 10장에서 평균값이 주기적인 한 프레임 놓침을 가린다고 한 것과 같은 내용이다. <strong>Input 평균이 좋아 보여도 Insights 타임라인에서 프레임별 패턴을 봐야 하는 이유</strong>가 여기 있다.</p>
</div>

<div class="callout callout-info">
<div class="callout-title">참고: 사람은 어느 정도까지 느끼나</div>
<p>연구 쪽 숫자를 같이 보면 이 장르의 기준이 유별난 것이 아님을 알 수 있다. Carmack은 VR 지연을 정리한 글에서 <strong>절대 지연이 약 20ms 아래면 대체로 지각되지 않고, 총 50ms는 반응은 되지만 미묘하게 끌린다</strong>고 적었다. 조준 과제를 다룬 CHI 2015 연구는 실제 환경의 로컬 지연이 23~243ms에 분포하며 <strong>41ms 정도의 낮은 지연에서도 유의한 성능 저하</strong>가 나타난다고 보고했고, 경쟁 FPS 플레이어를 대상으로 한 CHI 2021 연구는 <strong>125ms 이하 구간에서도 작은 감소가 정확도와 점수를 뚜렷하게 개선</strong>한다고 결론했다. 터치 지연을 1ms까지 낮춰 본 UIST 2012 연구는 <strong>10ms 아래에서도 개선이 계속 지각된다</strong>고 했다. 즉 "이미 충분히 낮다"고 말할 수 있는 지점이 생각보다 훨씬 아래에 있다.</p>
</div>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">철권 7에서 철권 8까지: 7.2프레임에서 2.4프레임으로</h2>

<p style="color:var(--text2);line-height:1.85;">
언리얼로 만든 격투 게임의 지연 문제는 철권 시리즈의 역사로 거의 정리된다. 아래 데이터는 Nigel Woodall이 비디오 신호를 직접 끊어 재는 방식으로 오래 측정해 공개해 온 값이다. <strong>모니터 지연이 빠진 값</strong>이라, 이 글에서 다룬 Input과 재는 구간이 가깝다.
</p>

<div class="data-table">
<table>
<tr><th>시점</th><th>플랫폼</th><th>측정값</th><th>프레임</th><th>무슨 일이 있었나</th></tr>
<tr><td>2017-06 철권 7 출시</td><td>PS4</td><td>120.1 ms</td><td>7.2f</td><td>UE4 기반. 커뮤니티에서 즉시 문제 제기</td></tr>
<tr><td>2017-12 철권 7 패치 1.10</td><td>PS4</td><td>92.6 ms</td><td>5.6f</td><td>공식 패치 노트: "Reduced Input Delay on PS4 &amp; XB1"</td></tr>
<tr><td>2019-10 철권 7</td><td>PS4</td><td>73.5 ms</td><td>4.4f</td><td>추가 감소. 원인 패치는 공개 확인 불가</td></tr>
<tr><td>2024-01 철권 8</td><td>PS5</td><td>58.9 ms</td><td>3.5f</td><td>UE5. Nanite, Lumen 미사용, 60fps 고정</td></tr>
<tr><td>2024-01 철권 8</td><td>Xbox Series X</td><td>57.3 ms</td><td>3.4f</td><td>같은 빌드 계열</td></tr>

</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
표의 값은 모두 같은 방식(모니터 제외)으로 재서 서로 비교할 수 있다. PC 값이 빠진 것은 측정 방법이 달라서다. 같은 계측자가 화면에 광센서를 붙여 <strong>모니터까지 포함해</strong> 잰 철권 8의 PC 값은 <strong>39.5ms(2.4프레임)</strong>였다. 240Hz 모니터에 가변 리프레시(G-Sync), 전체화면, 드라이버 저지연을 최대로 둔 조건이다. 눈여겨볼 점은 <strong>모니터를 포함한 PC 값이 모니터를 뺀 PS5 값보다도 20ms 가까이 낮다</strong>는 것이다. 출시 당시의 120ms와 비교하면 <strong>3분의 1</strong>이다. 이 과정 초반에 나온 개발자 발언이 이 글의 08장을 그대로 가리킨다. 2017년 7월, 시리즈 총괄 하라다 카츠히로는 트위터에서 원인을 엔진으로 지목했다.
</p>

<div class="callout callout-warn">
<div class="callout-title">개발자 발언</div>
<p>"UE4 eat 3-4frames &amp; They don't know hardware side mechanism" (하라다 카츠히로, 2017년 7월)</p>
<p>그리고 같은 해 11월 대회 현장에서, 통역을 통해 이렇게 말했다. <strong>"엔진 팀에 협조를 요청하기 전에, 우리 쪽에서 먼저 입력 지연 2프레임을 없앴습니다. 그런데 여러분은 눈치채지 못했죠."</strong> 이어서 <strong>"Epic과 이야기했고, 엔진 쪽에 지연이 조금 있었습니다. 그쪽에서 그걸 고쳐 주었습니다."</strong></p>
<p>이 두 문장에 이 글의 구조가 다 들어 있다. <strong>게임 코드에서 걷어낼 2프레임</strong>(틱 순서, 입력을 읽는 위치, 게임이 자체로 넣은 버퍼링)과 <strong>엔진에서 걷어낼 프레임</strong>(스레드 겹침, Present 큐)이 따로 있고, 둘 다 해야 한다는 것이다.</p>
</div>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">첫째, 그래픽 기능을 포기한다</h2>

<p style="color:var(--text2);line-height:1.85;">
철권 8이 UE5로 넘어가며 한 선택이 가장 알기 쉬운 예다. <strong>Nanite와 Lumen을 쓰지 않았다.</strong> UE5의 간판 기능 두 개를 뺀 이유로 개발진이 든 것은 60fps를 반드시 지킨다는 목표였다. 여기에 동적 해상도를 붙여 4K에서 최소 50%까지 내려가게 했고, 실제로는 1440p 근처에서 도는 경우가 많았다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 선택이 왜 지연 문제인지는 09장에서 본 그림이 설명한다. <strong>GPU 시간이 프레임 예산에 닿기 시작하면 대기가 Present 큐로 옮겨 가고, 프레임 레이트는 그대로인데 지연만 늘어난다.</strong> 그래서 이 장르는 평균 GPU 시간이 아니라 <strong>가장 오래 걸리는 프레임</strong>을 기준으로 예산을 짠다. 화면에 캐릭터 둘과 배경 하나만 두는 구성이 유리한 실질적인 이유이기도 하다. 장면 복잡도가 크게 흔들리지 않으니 최악값을 예측할 수 있다.
</p>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">둘째, 파이프라인을 얕게 유지한다</h2>

<p style="color:var(--text2);line-height:1.85;">
08장의 변수들이 여기서 쓰인다. 스레드 겹침을 줄이고 Present 큐를 얕게 두면 지연이 프레임 단위로 떨어진다. 대가는 <strong>어느 한 단계가 순간적으로 늦어져도 버티는 힘</strong>이다. 파이프라인이 깊으면 한 스레드가 한 번 늦어도 다른 단계가 그 시간을 흡수해 준다. 얕으면 그 늦어짐이 곧바로 프레임 드롭이 된다.
</p>

<p style="color:var(--text2);line-height:1.85;">
격투 게임은 이 교환을 받아들인다. 다른 장르라면 가끔 프레임이 하나 떨어지는 것보다 지연 한 프레임을 감수하는 쪽을 고르는데, 이 장르는 반대다. 대신 프레임 드롭 자체가 안 나도록 장면을 통제하는 쪽으로 문제를 옮긴다. 앞의 두 선택이 서로 맞물려 있다는 점이 중요하다. <strong>얕은 파이프라인은 프레임 시간이 안정적일 때만 성립한다.</strong>
</p>

<p style="color:var(--text2);line-height:1.85;">
이 선택을 아예 <strong>플레이어에게 맡긴</strong> 사례도 있다. UE4에서 UE5로 옮긴 멀티버서스는 그래픽 설정 메뉴에 "One Frame Thread Lag" 항목을 그대로 내놨다. 08장에서 본 그 콘솔 변수다. 켜면 프레임 레이트가 오르고 입력 지연이 늘어난다. 그래서 경쟁 플레이에서는 끄라는 안내가 커뮤니티 가이드에 붙어 있다. 개발사 공식 문서로 확인된 내용은 아니지만, <strong>엔진 내부의 교환 관계가 사용자 설정 항목으로 올라온 사례</strong>다.
</p>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">셋째, 엔진 종류보다 출력 설정이 더 중요하다</h2>

<p style="color:var(--text2);line-height:1.85;">
같은 엔진으로 만든 게임들의 실측값을 나란히 놓으면 이 결론이 나온다. 같은 엔진 안에서의 차이가 엔진 사이의 차이보다 훨씬 크다.
</p>

<div class="data-table">
<table>
<tr><th>게임</th><th>엔진</th><th>플랫폼</th><th>측정값</th><th>프레임</th></tr>
<tr><td>길티기어 스트라이브</td><td>UE4</td><td>PS5</td><td>42.0 ms</td><td>2.5f</td></tr>
<tr><td>그랑블루 판타지 버서스 라이징</td><td>UE4</td><td>PS5 네이티브</td><td>87.4 ms</td><td>5.3f</td></tr>
<tr><td>그랑블루 판타지 버서스 라이징</td><td>UE4</td><td><strong>같은 게임의 PS4 빌드를 PS5에서 실행</strong></td><td><strong>41.2 ms</strong></td><td><strong>2.5f</strong></td></tr>
<tr><td>드래곤볼 파이터즈</td><td>UE4</td><td>PS5</td><td>72.8 ms</td><td>4.4f</td></tr>
<tr><td>모탈 컴뱃 1</td><td>UE4</td><td>PS5</td><td>57.6 ms</td><td>3.5f</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
세 번째 줄이 이 표의 핵심이다. <strong>같은 게임인데 구형 콘솔용 빌드를 신형 콘솔에서 돌리는 쪽이 신형 전용 빌드보다 두 배 이상 빨랐다.</strong> 다른 게임에서도 같은 역전이 나온다. 아랑전설 시티 오브 더 울브즈는 PS5 전용 빌드가 79.1ms인데, PS4 빌드를 PS5 Pro에서 돌리면 46.4ms였다. 더 강한 하드웨어에서 더 느리게 나온 것이니 원인은 성능이 아니다. <strong>화면에 그림을 내보내는 경로와 동기화 설정</strong>이 원인이고, 08장의 변수들이 빌드마다 다르게 잡혔다는 뜻이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 실제로 프레임을 줄여 주는 항목은 렌더링이 아니라 출력 쪽에 있다. 측정된 효과가 큰 순서로 정리하면 이렇다.
</p>

<div class="data-table">
<table>
<tr><th>바꾸는 것</th><th>측정된 효과</th><th>대가</th></tr>
<tr><td><strong>전용 입력 지연 감소 옵션</strong></td><td>스트리트 파이터 6의 PS5에서 켬 55.1ms, 끔 100.4ms. <strong>약 45ms ≈ 2.7프레임</strong></td><td>내부 구현 미공개. 기본값이 아니라 플레이어가 켜야 한다</td></tr>
<tr><td><strong>VSync 끄기</strong></td><td>언더나이트 인버스 2의 PS5에서 켬 56.5ms → 끔 16.7ms(화면 상단), 7.0ms(하단)</td><td>티어링이 생긴다. 값이 화면 위치마다 달라서 대표값을 못 뽑는다</td></tr>
<tr><td><strong>120Hz 출력</strong></td><td>스트리트 파이터 6 Xbox Series X에서 120Hz 54.8ms vs 60Hz 82.4ms. 철권 8, 길티기어도 6~7ms씩 개선</td><td>없음에 가깝다. 다만 디스플레이가 지원해야 한다</td></tr>
<tr><td><strong>가변 리프레시</strong><br>(모니터가 정해진 주기 대신 프레임이 올 때마다 화면을 바꾸는 기능. G-Sync, FreeSync)</td><td>아랑전설 시티 오브 더 울브즈는 PS5 가변 리프레시 지원 패치로 68ms → 45.8ms</td><td>없음. 단 PS5는 "미지원 타이틀에도 적용" 옵션까지 켜야 효과가 난다</td></tr>
<tr><td><strong>PC 고주사율 + 저지연 조합</strong></td><td>철권 8이 2.4프레임, 길티기어 스트라이브는 1.0프레임(17.1ms)까지</td><td>하드웨어. 그리고 이 설정을 플레이어가 알아야 한다</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
표의 첫 줄을 눈여겨볼 만하다. 전용 옵션 하나가 2.7프레임을 바꾸니, 대회 규정이 그 옵션을 강제한다. EVO Japan 2026의 스트리트 파이터 6 규칙은 기본값에서 벗어나도 되는 예외 항목으로 <strong>"입력 지연 감소: ON"</strong>을 적어 두었다. 반면 EVO 메인 규정에는 모니터 지연에 관한 조항이 없다. 컨트롤러 규정은 무선 금지, 특정 컨버터 금지까지 상세한데 말이다. <strong>플레이어가 통제할 수 있는 지연만 규정 대상</strong>인 셈이다.
</p>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">넷째, 온라인에서는 지연을 일부러 넣는다</h2>

<p style="color:var(--text2);line-height:1.85;">
여기서 방향이 한 번 뒤집힌다. 내 컴퓨터 안의 지연은 그렇게까지 줄이는데, 온라인 대전에서는 <strong>입력 지연을 일부러 더한다</strong>. 상대 입력이 도착할 시간을 벌려고 내 입력의 반영을 몇 프레임 늦추는 방식이다. 롤백 넷코드는 이 지연을 최소로 두는 대신, 상대 입력을 예측했다가 틀리면 그 프레임들을 되감아 다시 계산한다.
</p>

<p style="color:var(--text2);line-height:1.85;">
최근에는 이 값을 고정하지 않는 방식도 나온다. UE5로 만든 라이벌즈 오브 이더 2는 롤백 미들웨어를 써서 <strong>플레이어마다 네트워크 상태에 맞춰 입력 지연을 실시간으로 조절</strong>한다. 판정이 프레임 단위인 게임이 이런 조절을 할 수 있는 이유는 게임 로직이 매번 같은 간격으로 돌아 프레임 경계가 분명하기 때문이다. 경쟁 FPS도 같은 방식을 쓴다. 라이엇은 발로란트의 게임 로직을 <strong>렌더 프레임 레이트와 상관없이 정확히 초당 128회</strong> 돌린다고 공개했고, 클라이언트 지연 예산도 ms가 아니라 프레임 단위로 적는다.
</p>

<p style="color:var(--text2);line-height:1.85;">
그래서 이 장르의 지연 논의에는 늘 두 숫자가 따라다닌다. <strong>내 컴퓨터 안의 파이프라인 지연과 넷코드가 일부러 넣은 지연</strong>이다. 앞의 것은 엔진과 하드웨어 문제이고, 뒤의 것은 설계 선택이다. 이 글이 다룬 <code>stat unit</code>의 Input은 앞의 것만 재고, 온라인 대전에서 플레이어가 체감하는 값은 둘의 합이다. 파이프라인에서 1프레임 줄이는 작업이 의미 있는 이유도 여기 있다. 넷코드 쪽은 네트워크 상태 때문에 줄이기 어려우니, 줄일 수 있는 쪽에서 줄여 두는 것이다.
</p>

<h2 style="font-size:1.05rem;font-weight:700;color:var(--text);margin:28px 0 8px;">덧붙임: 같은 게임을 두 방법으로 재면 모니터 몫이 나온다</h2>

<p style="color:var(--text2);line-height:1.85;">
05장에서 Input에는 모니터 몫이 빠져 있다고 했다. 그 빠진 몫이 실제로 얼마인지 볼 수 있는 데이터가 있다. 같은 계측자가 같은 게임을 두 가지 방법으로 쟀기 때문이다. 비디오 신호를 끊어 재는 방법은 <strong>모니터를 빼고</strong> 재고, 화면에 광센서를 붙이는 방법은 <strong>모니터까지 포함해</strong> 잰다.
</p>

<div class="data-table">
<table>
<tr><th>게임, 플랫폼</th><th>모니터 제외</th><th>모니터 포함</th><th>차이 = 모니터 몫</th></tr>
<tr><td>철권 8, PS5</td><td>58.9 ms</td><td>65.7 ms</td><td>약 6.8 ms</td></tr>
<tr><td>길티기어 스트라이브, PS5</td><td>42.0 ms</td><td>50.1 ms</td><td>약 8.1 ms</td></tr>
</table>
</div>

<p style="color:var(--text2);line-height:1.85;">
두 방법의 차이가 <strong>반 프레임 정도</strong>로 일정하다. 계측자 본인도 자기가 쓴 모니터가 신호보다 약 8.3ms 늦게 그린다고 적어 두었다. 이 숫자를 우리 프로젝트에 적용하면 이렇게 된다. <strong><code>stat unit</code>의 Input에 컨트롤러 몫과 모니터 몫 반 프레임 남짓을 더한 값이 플레이어가 체감하는 지연에 가깝다.</strong> 더하는 두 항은 우리가 손댈 수 없으니, <strong>Input을 30ms 근처로 유지하는 프로젝트는 이 장르 최상위권과 같은 파이프라인 깊이</strong>라고 봐도 된다.
</p>

<div class="callout callout-teal">
<div class="callout-title">숫자를 인용할 때의 규칙</div>
<p>이 장의 값들은 계측 방법이 서로 다르므로 <strong>다른 출처의 숫자와 나란히 놓지 않는 것</strong>이 원칙이다. 모니터를 포함했는지, 화면 위쪽을 봤는지 아래쪽을 봤는지, 무엇을 반응으로 볼지(캐릭터 동작이 시작되는 시점인지 입력 표시 UI가 뜨는 시점인지)에 따라 같은 게임이 10ms 이상 달라진다. 같은 게임 같은 플랫폼에서 보는 대상만 바꿔 11ms 차이가 난 기록도 있다. 이 글 전체의 주제가 그것이다. <strong>지연 숫자는 무엇에서 무엇까지인지를 함께 적어야 숫자가 된다.</strong></p>
</div>
</div>


<div class="research-post">
<span class="section-eyebrow">정리</span>
</div>

# 정리

<div class="research-post">
<p style="color:var(--text2);line-height:1.85;">
한 문장으로 줄이면 이렇다. <strong><code>stat unit</code>의 Input은 게임 스레드가 프레임 시작에 적어 둔 시간과, DXGI가 알려 준 그 프레임이 화면에 표시되기 시작한 시간의 차이를 밀리초로 바꿔 평균낸 값이다. 컨트롤러 조회 주기, OS 큐 대기, 모니터 내부 처리는 이 숫자 밖에 있다. 그래서 스펙으로 내놓기에는 부족하지만, 엔진이 손댈 수 있는 구간과 재는 구간이 정확히 겹치기 때문에 파이프라인 깊이를 재는 도구로는 알맞다.</strong>
</p>

<div class="card-grid">
<div class="card teal">
<div class="card-label">VBlank − Input</div>
<div class="card-title">두 시점의 뺄셈, 그게 전부다</div>
<div class="card-desc">게임 스레드가 프레임 번호를 키로 시간을 적고, RHI 스레드가 프레임 번호와 Present 카운터를 짝짓고, 전용 스레드가 <code>SyncQPCTime</code>으로 화면에 표시되기 시작한 시간을 받아 뺀다. 짝을 못 찾으면 새 값을 쓰지 않고 직전 값을 그대로 둔다.</div>
</div>
<div class="card gold">
<div class="card-label">마커 ≠ 버튼</div>
<div class="card-title">시작점은 버튼이 아니라 입력을 읽기 시작한 시점</div>
<div class="card-desc">마커는 메시지 펌프 바로 앞에 있다. 그 프레임이 처리하는 이벤트는 마커보다 먼저 도착해 있었으니, 실제 지연은 항상 이 값보다 크다. 엔진 주석도 "roughly track", 대략적으로 추적한다고 적어 두었다.</div>
</div>
<div class="card blue">
<div class="card-label">기다림의 위치</div>
<div class="card-title">지연은 일의 양이 아니라 순서 문제</div>
<div class="card-desc">남는 시간을 입력을 읽기 전에 쓰면 지연이 안 늘고, 읽은 뒤에 쓰면 그만큼 지연이 된다. GPU가 병목이 되면 대기가 저절로 Present 큐로 옮겨 간다. Reflex와 Anti-Lag 2가 하는 일은 그 대기를 앞으로 되돌리는 것이다.</div>
</div>
<div class="card coral">
<div class="card-label">비교 금지</div>
<div class="card-title">다른 계측과 같은 축에 놓지 말 것</div>
<div class="card-desc">Reflex의 총 지연은 시뮬레이션 시작부터 GPU 렌더 종료까지, Input은 입력 마커부터 화면에 표시되기 시작할 때까지다. 어느 쪽도 다른 쪽을 포함하지 않는다. 장비로 잰 값과의 차이가 엔진 밖 구간의 합이다.</div>
</div>
</div>

<p style="color:var(--text2);line-height:1.85;">
핵심 숫자들만 모아 두자. 새 값 섞는 비율 10%(다 반영되기까지 열 프레임쯤), Max 구간 200프레임, 프레임 정보 보관 16프레임, 색 기준 2.5배, 윈도우 D3D12 백버퍼 3개, DXGI 기본 최대 프레임 지연 3(대기 가능 스왑체인은 1), <code>rhi.SyncSlackMS</code> 기본 10ms, <code>r.GTSyncType</code> 기본 0에서 RHI 겹침 2프레임, 60Hz 1프레임 16.67ms. 짝은 Present 카운터가 정확히 일치할 때만 성립하고 오차를 허용하지 않는다. 그리고 가장 중요한 규칙은 코드에 없다. <strong>파이프라인 단계를 하나 걷어낼 때마다 지연이 한 프레임 줄고, 어느 한 단계가 순간적으로 늦어져도 버티는 힘이 그만큼 줄어든다.</strong> 철권 7이 7.2프레임에서 4.4프레임으로, 철권 8이 다시 2.4프레임까지 내려간 과정은 렌더링을 빠르게 한 과정이 아니라 이 교환을 반복해서 치른 과정이다.
</p>

<p style="color:var(--text2);line-height:1.85;">
이 관점으로 보면 다른 주제와도 이어진다. <a href="/asynccompute">async compute</a> 글이 GPU 작업을 겹쳐서 처리량을 얻는 쪽을 다뤘다면, 이 글은 그렇게 겹친 대가를 확인하는 쪽이다. <a href="/pso">PSO 히칭</a>은 얕은 파이프라인이 가장 취약한 종류의 프레임 스파이크이고, <a href="/tsr">TSR</a>처럼 프레임 간 정보를 쌓아 쓰는 기법은 프레임 시간이 안정적일 때만 성립한다. 지연은 렌더링에 딸린 부수적인 문제가 아니라, 렌더링 구조를 그렇게 짠 대가로 치르는 항목이다.
</p>

<span class="section-eyebrow">참고</span>

<div class="card-grid" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));">
<div class="card blue">
<div class="card-label">엔진 소스</div>
<div class="card-title">언리얼엔진 5.8</div>
<div class="card-desc"><code>RHI/Private/RHIUtilities.cpp</code>, <code>RHI/Public/RHIUtilities.h</code>(입력 마커, Present 카운터 짝짓기, 지연 계산, 플립 추적), <code>RHICore/Private/DXGIUtilities.cpp</code>(VBlank 추적 스레드), <code>Engine/Private/UnrealClient.cpp</code>(<code>stat unit</code> 표시와 평균, Max), <code>Launch/Private/LaunchEngineLoop.cpp</code>(마커 위치와 프레임 순서), <code>RenderCore/Private/RenderingThread.cpp</code>(<code>FFrameEndSync</code>, 스레드 겹침 깊이), <code>Engine/Private/UnrealEngine.cpp</code>(프레임 리미터, 틱 레이트 핸들러), <code>D3D12RHI/Private/D3D12Viewport.cpp</code>, <code>Windows/WindowsD3D12Viewport.cpp</code>(Present, 티어링, 스왑체인), <code>Core/Private/HAL/ConsoleManager.cpp</code>(<code>r.VSync</code>, <code>r.FinishCurrentFrame</code>), <code>Plugins/Runtime/Nvidia/Reflex</code>(마커 모듈, 틱 레이트 핸들러). 이 글의 모든 코드 인용의 1차 출처.</div>
</div>
<div class="card teal">
<div class="card-label">플랫폼 문서</div>
<div class="card-title">DXGI가 화면에 프레임을 내보내는 방식과 지연</div>
<div class="card-desc"><a href="https://learn.microsoft.com/en-us/windows/win32/api/dxgi/ns-dxgi-dxgi_frame_statistics">DXGI_FRAME_STATISTICS</a>(<code>SyncQPCTime</code>, <code>PresentCount</code> 정의), <a href="https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiswapchain-getframestatistics">GetFrameStatistics</a>(blt 창 모드 불가, DISJOINT, 다중 모니터 주의), <a href="https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/dxgi-flip-model">DXGI flip model</a>, <a href="https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/for-best-performance--use-dxgi-flip-model">For best performance, use DXGI flip model</a>, <a href="https://learn.microsoft.com/en-us/windows/uwp/gaming/reduce-latency-with-dxgi-1-3-swap-chains">Reduce latency with DXGI 1.3 swap chains</a>("거의 한 프레임을 더 기다리는 평형" 인용의 출처), <a href="https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgidevice1-setmaximumframelatency">SetMaximumFrameLatency</a>(기본 3, 범위 1~16).</div>
</div>
<div class="card gold">
<div class="card-label">벤더, 도구</div>
<div class="card-title">저지연 경로와 계측</div>
<div class="card-desc"><a href="https://dev.epicgames.com/documentation/en-us/unreal-engine/low-latency-frame-syncing-in-unreal-engine">Epic, Low-Latency Frame Syncing</a>(<code>r.GTSyncType</code>, <code>rhi.SyncSlackMS</code>의 공식 교환 관계 설명과 30Hz 예시 수치), <a href="https://www.nvidia.com/en-us/geforce/news/reflex-low-latency-platform/">NVIDIA Reflex 소개</a>, <a href="https://www.nvidia.com/en-us/geforce/guides/system-latency-optimization-guide/">시스템 지연 최적화 가이드</a>(구간 정의), <a href="https://www.nvidia.com/en-us/geforce/news/reflex-2-even-lower-latency-gameplay-with-frame-warp/">Reflex 2 Frame Warp</a>, <a href="https://gpuopen.com/anti-lag-2/">AMD Anti-Lag 2</a>("입력을 읽기 직전에 넣는다"), <a href="https://github.com/GameTechDev/PresentMon">Intel PresentMon</a>(Click To Photon, Display Latency 정의), <a href="https://developer.nvidia.com/nvidia-latency-display-analysis-tool">NVIDIA LDAT</a>.</div>
</div>
<div class="card purple">
<div class="card-label">토대 문헌</div>
<div class="card-title">지연은 얼마나 지각되는가</div>
<div class="card-desc">Carmack, <a href="https://danluu.com/latency-mitigation/">"Latency Mitigation Strategies"</a>(2013, 파이프라인 분해와 late input sampling, time warp의 원전); Ivkovic et al., "Quantifying and Mitigating the Negative Effects of Local Latencies on Aiming in 3D Shooter Games"(CHI 2015); Liu, Claypool et al., "Lower is Better?"(CHI 2021, 125ms 이하 구간); Ng et al., "Designing for Low-Latency Direct-Touch Input"(UIST 2012, 1ms 터치); Claypool &amp; Claypool, "Latency and player actions in online games"(CACM 2006, precision, deadline 분류); <a href="https://www.riotgames.com/en/news/peeking-valorants-netcode">Riot, "Peeking into VALORANT's Netcode"</a>(고정 128Hz 시뮬레이션과 프레임 단위 지연 예산).</div>
</div>
<div class="card orange">
<div class="card-label">실측 데이터</div>
<div class="card-title">격투 게임 입력 지연 측정</div>
<div class="card-desc"><a href="https://sites.google.com/view/noodallsinputlagtestingresults/home">Nigel Woodall(noodalls) 입력 지연 측정 결과</a>. 비디오 신호를 끊어 재는 방식(모니터 제외)과 화면에 광센서를 붙이는 방식(모니터 포함)의 측정 방법 설명, 그리고 게임별 원본 데이터. 이 글 11장의 거의 모든 수치의 1차 출처. <a href="https://inputlag.science/engine/results">inputlag.science</a>(Loïc Petit, stability 지표의 출처), <a href="https://displaylag.com/video-game-input-lag-database/">DisplayLag 데이터베이스</a>(등급 구간), <a href="https://www.digitalfoundry.net/articles/digitalfoundry-2024-tekken-8-a-brilliant-fighting-game-packed-with-great-tech-and-a-vast-array-of-options">Digital Foundry, 철권 8 기술 리뷰</a>, <a href="https://www.eventhubs.com/news/2017/nov/13/harada-tekken-7s-input-lag-was-reduced-2-frames-people-didnt-notice-more-reductions-coming-within-year/">하라다 발언 보도</a>.</div>
</div>
<div class="card coral">
<div class="card-label">이 블로그</div>
<div class="card-title">이어 읽기</div>
<div class="card-desc"><a href="/asynccompute">Async Compute</a>(파이프라인 겹침으로 처리량을 얻는 쪽을 다룬 글), <a href="/pso">PSO와 히칭</a>(얕은 파이프라인이 가장 취약한 프레임 스파이크), <a href="/tsr">TSR</a>, <a href="/taa">TAA</a>(프레임 간 누적이 프레임 안정성에 기대는 구조), <a href="/d3d12-residency-sbt">D3D12 Residency와 SBT</a>(Submit 경계에서 무엇이 일어나는가), <a href="/gpudriven">GPU Driven Rendering</a>(GPU 시간을 줄여 지연의 여유를 만드는 쪽).</div>
</div>
</div>
</div>
