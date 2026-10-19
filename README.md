# Road Rush

An endless top-down dodge racer that runs in the browser. Hold the gas and you hit 300 km/h in about six seconds. Weave through traffic for as long as you can. One hit and it's over.

The art is AI-generated: the road, car, steering wheel and pedals came from ChatGPT, and the intro and crash clips from Gemini. The game itself is plain HTML, CSS and JavaScript with no build step and no libraries.

## Controls

- **Keyboard:** arrows or WASD. Up is gas, down or Space is brake.
- **Phone / touch:** hold the phone sideways. Put a thumb anywhere left of the road and slide it to steer. Anywhere right of the road is the pedals: brake on the inner half, gas on the outer half, and you can slide between them.
- **Mouse:** same zones as touch.
- **M** toggles sound.

On Android, tapping RACE goes fullscreen and hides the browser bar. On iPhone, use Share → Add to Home Screen, and it opens as a full-screen app.

## Run it locally

```bash
python tools/serve.py
```

Then open http://localhost:8080.

## Swapping the art

Drop new pictures into `assets/` (`road.png`, `car.png` and `controls.png` on a flat green background), then run:

```bash
python tools/prep_assets.py
```

It cuts out the green, makes the traffic colours, splits the wheel and pedals, and measures the road edges into `assets/cut/`.
