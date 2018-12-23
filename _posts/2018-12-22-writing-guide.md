---
title: 기고자를 위한 글쓰기 안내문
date: 2018-12-22
tags:
- tutorial
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

__bold__, _italic_, ~~줄 긋기~~ 를 사용할 수 있습니다.

```nil
_italic_
__bold__
*italic*
**bold**
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
## interactive editor 사용법

newgamedev 에서는 기술적인 글을 독자가 보다 쉽게 이해할 수 있도록 interactive editor 를 제공하고 있습니다.
