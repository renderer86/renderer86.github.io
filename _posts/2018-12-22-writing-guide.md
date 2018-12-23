---
title: 기고자를 위한 글쓰기 안내문
date: 2018-12-22
tags:
- tutorial
interactive: true
threejs: true
shader: true
---

![](<../images/write.jpg>)
image from [link](<https://studybreaks.com/culture/nanowrimo-step-up-your-writing-game/>)

> 이 문서는 [newgamedev.github.io](<https://newgamedev.github.io>) 에 기고를 할 때의 글쓰기 방법에 대한 가이드입니다.

&nbsp;
## 기본적인 markdown 사용법

이 홈페이지는 Jekyll 기반의 Github pages 를 사용하고 있습니다. Github pages 는 [2016년 5월 1일부터](<https://blog.github.com/2016-02-01-github-pages-now-faster-and-simpler-with-jekyll-3-0/>) [kramdown](<https://github.com/gettalong/kramdown>) 이라는 markdown 생성기만 지원하고 있습니다.

여기서는 이 kramdown 에서 자주 쓰이는 문법을 정리해봅니다. 더 자세한 내용은 [kramdown 공식 가이드](<https://kramdown.gettalong.org/syntax.html>), [github help 페이지](<https://help.github.com/articles/basic-writing-and-formatting-syntax/>)를 참고해주시기 바랍니다.

### 헤더

소제목입니다. 자동으로 글 가장 위쪽의 table of contents 에 들어가게 됩니다.

```nil
# h1
## h2
### h3
#### h4
##### h5
###### h6
```

### 강조

_italic_, __bold__, ___bold and italic___, ~~줄 긋기~~ 를 사용할 수 있습니다.

```nil
_italic_
__bold__
___bold and italic___
*italic*
**bold**
***bold and italic***
~~line through~~
```

### 링크, 이미지

[링크](<https://newgamedev.github.io/writing-guide/>)와 이미지는 비슷한 문법으로 사용할 수 있습니다. 글 없이 이미지만 나오게 할 때는 링크 앞에 `!` 를 붙이고 링크 안의 문장은 alt(대체 문자열) 로 쓰입니다.

```nil
[text](<link address>)
![alt text](<image address>)
```

### 코드

`인라인 코드`는 \` 를 앞뒤에 붙여서 나타냅니다. \` 나 `~` 를 세 개씩 위 아래로 쓰고 줄바꿈으로 사이 줄에 코드를 쓰면 코드 블록을 정의할 수 있습니다. Github pages 는 [rouge](https://github.com/jneen/rouge) 를 사용해서 코드 블록에 자동으로 syntax highlighting 을 해줍니다. 언어를 명시하지 않아도 잘 찾아주긴 하지만 의도대로 결과가 나오도록 하려면 언어를 명시해주는 것이 좋습니다.

띄어쓰기 4개를 이용해도 코드 블록을 만들 수 있지만 syntax highlighting 을 원하는 언어로 지정할 수 없습니다.

```nil
`inline code`
~~~ javascript
console.log('code block');
~~~
```

### 들여쓰기 (인용구)

`>` 를 라인의 맨 앞에 써서 들여쓰기를 할 수 있습니다. 두 개 이상 쓰면 들여쓰기 안에서 들여쓰기를 만들 수 있습니다.

```nil
> blockquote
>> nested blockquote
>> nested blockquote
> blockquote
```

### 리스트

라인 앞에 `*`, `+`, `-` 을 쓰면 순서(숫자) 없는 리스트를, `1.`, `2.` 등을 쓰면 순서 있는 리스트를 만들어줍니니다.

```nil
* un
+ ordered
- list

1. ordered
2. list
```

### 체크 리스트

- [x] 리스트에 체크박스를 추가할 수 있습니다.
- [ ] 체크된 항목은 대괄호 안에 x 를 넣어줍니다.

```nil
- [x] checked
- [ ] unchecked
```

### 각주

페이지의 끝에 각주를 달 수 있습니다. `[^1]`, `[^2]` 로 숫자를 직접 지정할 수도 있고, `[^n]` 을 써서 자동으로 넘버링되게 할 수 있습니다.

```nil
footnote[^n]
[^n]: foot note description
```


&nbsp;
## 수학식 (MathJax)

이 홈페이지는 [texts.github.io](<https://texts.github.io/>) 에서 Fork 되었습니다. texts.github.io 에서는 [MathJax](<https://www.mathjax.org/>) 를 사용해서 수학식을 표현합니다.

여기서는 기본적인 수식 사용 방법과 자주 쓰이는 수식들을 소개합니다. 자세한 내용은 위 홈페이지의 [Typesetting Math in Texts](<https://texts.github.io/typesetting-math-in-texts/>), [stackexchange-mathematics 의 정리글](https://math.meta.stackexchange.com/questions/5020/mathjax-basic-tutorial-and-quick-reference<>) 을 참고해주시기 바랍니다.


### 수식 사용

`$$` 를 수식 시작과 끝에 입력해서 사용할 수 있습니다. [코드 블록](<https://newgamedev.github.io/writing-guide/#%EC%BD%94%EB%93%9C>)처럼 줄바꿈을 통해 수식을 위한 별도의 공간을 마련할 수 있습니다. 이렇게 추가되는 수식은 중앙정렬로 표시됩니다.

```nil
there is a $$math expression$$ in sentence.
$$
center aligned math expression
$$
```

### 사칙연산

`+`, `-` 는 그대로 사용합니다. $$\times$$, $$\div$$, $$\pm$$, $$\mp$$, $$\cdot$$

```nil
$$\times$$, $$\div$$, $$\pm$$, $$\mp$$, $$\cdot$$
```

### 등호, 부등호, 거의 같음

등호는 `=` 를 그대로 사용합니다.

$$\lt$$, $$\gt$$, $$\leq$$, $$\geq$$, $$\neq$$, $$\simeq$$
```nil
$$\lt$$, $$\gt$$, $$\leq$$, $$\geq$$, $$\neq$$, $$\simeq$$
```

### 제곱(위첨자), 아래첨자, 분수

$$2^2=4$$, $$a_1=1$$, $$\frac{1}{2}$$
```nil
$$2^2=4$$, $$a_1=1$$, $$\frac{1}{2}$$
```

### 행렬

행렬은 `\left[\begin{matrix}`, `\end{matrix}\right]` 로 시작하고 끝납니다. `\\` 는 행을 구분하고, `&` 는 행 안에서의 열을 구분합니다.

$$
\left[\begin{matrix}1.6 & 1.2 \\ -1.2 & 1.6\end{matrix}\right] = \left[\begin{matrix}0.8 & 0.6 \\ -0.6 & 0.8\end{matrix}\right] \times \left[\begin{matrix}2 & 0 \\ 0 & 2\end{matrix}\right]
$$
```nil
$$
\left[\begin{matrix}1.6 & 1.2 \\ -1.2 & 1.6\end{matrix}\right] = \left[\begin{matrix}0.8 & 0.6 \\ -0.6 & 0.8\end{matrix}\right] \times \left[\begin{matrix}2 & 0 \\ 0 & 2\end{matrix}\right]
$$
```


&nbsp;
## interactive code editor 사용법

newgamedev 에서는 기술적인 글을 독자가 보다 쉽게 이해할 수 있도록 interactive code editor 를 제공하고 있습니다.
사용된 주요 라이브러리는 [codemirror](<https://codemirror.net/>), [three.js](<https://threejs.org/>) 이고 [Patricio Gonzalez Vivo](<https://github.com/patriciogonzalezvivo>) 가 [The Book of Shaders](<https://thebookofshaders.com/>) 를 위해 만든 [glslEditor](<https://github.com/patriciogonzalezvivo/glslEditor>) 의 작동 방식을 참고했습니다.

### 사용 방법

아래와 같이 `div` 로 감싼 `textarea` 를 만들고, `class` 에 `codeeditor` 를 명시해줍니다. 코드에 의도치 않은 공백이 생기지 않도록 `tag` 와 본문을 붙여서 써줍니다.

```html
<div>
    <textarea class='codeeditor readonly'>
console.log('hello world!');</textarea>
</div>
```

<div>
    <textarea class='codeeditor readonly'>
console.log('hello world!');</textarea>
</div>

&nbsp;
### 사용 가능한 class

`class` 에 따라서 codemirror 의 옵션을 설정할 수 있습니다.

현재 제공되는 옵션은 다음과 같습니다.

* `codeeditor` : 기본 옵션입니다.

* `readonly` : editor 의 편집을 불가능하게 합니다.

* `fragment` : fragment shader 를 편집하고 그 결과를 즉시 확인할 수 있는 canvas 를 만듭니다.

```html
<div>
    <textarea class='codeeditor fragment'>
uniform vec2 resolution;
uniform float time;
void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 col = 0.5 + 0.5*cos(time+uv.xyx+vec3(0,2,4));
    gl_FragColor = vec4(vec3(col), 1.0);
}</textarea>
</div>
```

<div>
    <textarea class='codeeditor fragment'>
uniform vec2 resolution;
uniform float time;
void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec3 col = 0.5 + 0.5*cos(time+uv.xyx+vec3(0,2,4));
    gl_FragColor = vec4(vec3(col), 1.0);
}





</textarea>
</div>

&nbsp;
* `fragment-graph` : fragment shader 를 이용해서 간단한 그래프를 그립니다. $$y = f(x)$$ 의 형태입니다.

```html
<div>
    <textarea class='codeeditor fragment-graph'>
y = fract(sin(x) * 5.0);</textarea>
</div>
```

<div>
    <textarea class='codeeditor fragment-graph'>
y = fract(sin(x) * 5.0);</textarea>
</div>

&nbsp;

&nbsp;

&nbsp;

&nbsp;

&nbsp;
* `canvas` : javascript 에서 접근할 수 있는 canvas 를 만들어서 코드의 실행 결과를 확인할 수 있게 합니다. canvas id 는 `'editor_canvas' + count.toString()` 입니다. 그래프 코드는 [The Book of Shaders](<https://thebookofshaders.com/>) 를 참조했습니다.

```html
<div>
    <textarea class='codeeditor canvas'>
let canvas = document.getElementById('editor_canvas_3');
let ctx = canvas.getContext('2d');
ctx.fillStyle = "#"+((1<<24)*Math.random()|0).toString(16);
ctx.arc(canvas.width/2, canvas.height/2, canvas.height/3, 0, Math.PI * 2);
ctx.fill();</textarea>
</div>
```

<div>
    <textarea class='codeeditor canvas'>
let canvas = document.getElementById('editor_canvas_3');
let ctx = canvas.getContext('2d');
ctx.fillStyle = "#"+((1<<24)*Math.random()|0).toString(16);
ctx.arc(canvas.width/2, canvas.height/2, canvas.height/3, 0, Math.PI * 2);
ctx.fill();</textarea>
</div>

&nbsp;
현재 `fragment`, `fragment-graph`, `canvas` 셋 중 하나만 있으면 해당 editor 를 생성합니다. 세 `class` 는 서로 중복해서 사용할 수 없습니다.


&nbsp;

&nbsp;

&nbsp;

&nbsp;

&nbsp;

* `inside` : `canvas` 또는 `renderer.domElement` 의 위치를 editor 안에 넣습니다. `fragment`, `fragment-graph` 는 기본이 `inside` 입니다.

* `outside` : `canvas` 또는 `renderer.domElement` 의 위치를 editor 밖으로 뺍니다. `canvas` 는 기본이 `outside` 입니다.

&nbsp;

_End of Document_
