(function() {
    window.onload = init();

    function init() {
        if (document.readyState === 'complete') {
            console.log('code editor initialized');

            // find textarea with 'codeeditor' class
            let text_area_array = document.getElementsByClassName('codeeditor');
            let len = text_area_array.length;
            console.log(len);

            for (let i = 0; i < len; i++) {
                let text_area = text_area_array[i];

                let initial_option = {
                    'mode': 'javascript',
                    'lineNumbers': true,
                    'theme': 'monokai'
                };

                if (hasClass(text_area, 'readonly')) {
                    initial_option['readOnly'] = true;
                }

                if (hasClass(text_area, 'fragment')) {
                    initial_option['mode'] = 'x-shader/x-fragment';
                }

                // @TODO: add option variation
                let editor = CodeMirror.fromTextArea(text_area, initial_option);

                // if (hasClass(text_area, 'console')) {
                //     let delay;
                //
                //     editor.on("change", function() {
                //         clearTimeout(delay);
                //         delay = setTimeout(updatePreview(editor), 300);
                //     });
                //
                //     let messages = [];
                //     // from https://stackoverflow.com/questions/19846078/how-to-read-from-chromes-console-in-javascript.
                //     // but got RangeError: Maximum call stack size exceeded
                //     console.defaultLog = console.log.bind(console);
                //     console.log = function(){
                //         // default &  console.log()
                //         console.defaultLog.apply(console, arguments);
                //         // new & array data
                //         messages.push(Array.from(arguments));
                //     }
                //
                //     let updatePreview = function(editor) {
                //         let console_output;
                //
                //         if (document.getElementById('editor_console_output_' + i.toString())) {
                //             console_output = document.getElementById('editor_console_output_' + i.toString());
                //         }
                //         else {
                //             console_output = document.createElement('div');
                //             console_output.id = 'editor_console_output_' + i.toString();
                //             editor.display.wrapper.parentNode.appendChild(console_output);
                //             addClass(console_output, 'consoleoutput');
                //             console_output.innerHTML = ' ';
                //         }
                //
                //         try {
                //             messages = [];
                //             eval(editor.getValue());
                //         }
                //         catch (e) {
                //             messages.push(e);
                //         }
                //
                //         console_output.innerHTML = messages;
                //     }
                //     setTimeout(updatePreview(editor), 300);
                // }
                if (hasClass(text_area, 'canvas')) {
                    let delay;

                    editor.on("change", function() {
                        clearTimeout(delay);
                        delay = setTimeout(updatePreview(editor), 300);
                    });

                    let updatePreview = function(editor) {
                        let canvas;

                        if (document.getElementById('editor_canvas_' + i.toString())) {
                            canvas = document.getElementById('editor_canvas_' + i.toString());
                        }
                        else {
                            canvas = document.createElement('canvas');
                            canvas.id = 'editor_canvas_' + i.toString();
                            editor.display.wrapper.parentNode.appendChild(canvas);
                            canvas.width = 360;
                            canvas.height = 300;
                            addClass(canvas, 'previewOutside');
                        }

                        eval(editor.getValue());
                    }
                    setTimeout(updatePreview(editor), 300);
                }
                else if (hasClass(text_area, 'fragment')) {
                    let delay;
                    let camera, scene, renderer;
                    let material, mesh;
                    let uniforms;
                    let VERTEX = `void main() { gl_Position = vec4( position, 1.0 ); }`;

                    init_3d();
                    animate();

                    function init_3d() {
                        camera = new THREE.Camera();
                        camera.position.z = 1;
                        scene = new THREE.Scene();
                        var geometry = new THREE.PlaneBufferGeometry(2, 2);
                        uniforms = {
                            time: {
                                type: "f",
                                value: 1.0
                            },
                            resolution: {
                                type: "v2",
                                value: new THREE.Vector2()
                            }
                        };
                        material = new THREE.ShaderMaterial({
                            uniforms: uniforms,
                            vertexShader: VERTEX,
                            fragmentShader: text_area.textContent
                        });
                        mesh = new THREE.Mesh(geometry, material);
                        scene.add(mesh);
                        renderer = new THREE.WebGLRenderer();
                        renderer.setPixelRatio(window.devicePixelRatio);
                        editor.display.wrapper.parentNode.appendChild(renderer.domElement);
                        uniforms.resolution.value.x = renderer.domElement.width;
                        uniforms.resolution.value.y = renderer.domElement.height;
                        addClass(renderer.domElement, 'previewInside');
                        onWindowResize();
                        window.addEventListener('resize', onWindowResize, false);
                    }

                    function onWindowResize(event) {
                        // let previewFrame = document.getElementById('shader_preview_1');
                        // let preview = previewFrame.contentDocument ||  previewFrame.contentWindow.document;
                        //
                        // renderer.setSize(preview.body.offsetWidth, preview.body.offsetHeight);
                        uniforms.resolution.value.x = renderer.domElement.width;
                        uniforms.resolution.value.y = renderer.domElement.height;
                    }

                    function animate() {
                        requestAnimationFrame(animate);
                        render();
                    }

                    function render() {
                        uniforms.time.value += 0.02;
                        renderer.render(scene, camera);
                    }

                    editor.on("change", function() {
                        clearTimeout(delay);
                        delay = setTimeout(updatePreview(editor), 300);
                    });

                    let updatePreview = function(editor) {
                        material = new THREE.ShaderMaterial({
                            uniforms: material.uniforms,
                            vertexShader: material.vertexShader,
                            fragmentShader: editor.getValue()
                        });
                        mesh.material = material;
                    }
                    setTimeout(updatePreview(editor), 300);
                }
            }
        }
        else {
            window.requestAnimationFrame(init);
        }
    }

    function hasClass(el, className) {
        if (el.classList)
            return el.classList.contains(className)
        else
            return !!el.className.match(new RegExp('(\\s|^)' + className + '(\\s|$)'))
    }

    function addClass(el, className) {
        if (el.classList)
            el.classList.add(className)
        else if (!hasClass(el, className)) el.className += " " + className
    }

    function removeClass(el, className) {
        if (el.classList)
            el.classList.remove(className)
        else if (hasClass(el, className)) {
            var reg = new RegExp('(\\s|^)' + className + '(\\s|$)')
            el.className=el.className.replace(reg, ' ')
        }
    }
})();
