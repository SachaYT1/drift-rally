# Drift Rally

Аркадный 3D-дрифт в браузере. Игрушечная машинка «Искра» носится по огромной городской площади: три
круга по трассе «Площадь», очки за дрифт-цепочки с множителем до ×5, монеты на трассе и за очки,
рекорды и лучший круг.

Игра рассчитана на компьютер с клавиатурой. Сервера нет: монеты и рекорды каждый игрок хранит в
`localStorage` своего браузера. Сборка — статический сайт, который можно выложить на любой хостинг.

Стек: TypeScript, [three.js](https://threejs.org/) (WebGL 2), Vite, синтезированный звук на Web Audio,
Vitest и Playwright для тестов.

## Управление

| Клавиша | Действие |
|---|---|
| `W` / `↑` | газ |
| `S` / `↓` | тормоз; задний ход, если держать почти на месте |
| `A` `D` / `←` `→` | руль |
| `Пробел` | ручник, вход в дрифт |
| `R` | вернуться на трассу (к последней отметке) |
| `Esc` | пауза |
| `M` | звук вкл/выкл |
| `Enter` | «В заезд» в гараже, «Ещё раз» на экране результатов |

Клавиши привязаны к физическим кнопкам, поэтому работают и в русской раскладке.

Как набирать очки: войдите в поворот на скорости, держите руль и нажмите пробел — машина уйдёт в
занос. Пока вы в заносе на асфальте и едете вперёд, капают очки; чем дольше цепочка, тем выше
множитель. После заноса есть 1,5 с, чтобы продолжить цепочку, потом она уходит в зачёт. Сильный удар
сжигает цепочку, сбитая банка или стакан стоят штрафа. Полные правила — в игре, вкладка «Правила».

## Запуск и npm-скрипты

Нужен Node.js 20, 22 или 24+ (проверено на 22).

```bash
npm install
npm run dev
```

| Скрипт | Что делает |
|---|---|
| `npm run dev` | dev-сервер Vite на http://127.0.0.1:5173 (в dev есть lil-gui с настройками и Stats) |
| `npm run build` | проверка типов и сборка в `dist/` |
| `npm run preview` | раздаёт собранный `dist/` на http://127.0.0.1:4173 |
| `npm run typecheck` | `tsc --noEmit` для игры и e2e-тестов |
| `npm test` | юнит-тесты Vitest (`src/**/*.test.ts`) |
| `npm run test:watch` | Vitest в режиме наблюдения |
| `npm run e2e` | smoke-тест Playwright на реальной видеокарте: собирает игру, поднимает preview на 4173 и проходит гараж → заезд → результаты |
| `npm run e2e:software` | тот же тест на программном рендере SwiftShader (машины и CI без GPU) |
| `npm run assets` | пересобирает модели в `public/models/` из паков Kenney (нужен интернет; готовые модели уже лежат в репозитории) |

Перед первым `npm run e2e` установите браузер: `npx playwright install chromium`.
`E2E_RENDERER=all npm run e2e` прогоняет оба варианта рендера. Скриншоты и трейсы падений
складываются в `test-results/`, HTML-отчёт — в `playwright-report/`.

Тестовый режим `?test` (`http://127.0.0.1:4173/?test`) отдаёт `window.__game` для автоматизации:
`startRace()`, `step(n, input)`, `autopilot(n)`, `finish()`, `state()`. В нём качество low, буфер
не больше 640×360, а симуляция идёт только по командам теста. `?test&quality=medium` — полный размер
для скриншотов и замеров FPS.

## Публикация

`npm run build` кладёт в `dist/` готовый статический сайт (около 2,5 МБ). Пути в сборке
относительные (`base: './'` в `vite.config.ts`), поэтому `dist/` работает и из корня домена, и из
подкаталога — например, `https://<user>.github.io/<repo>/`.

### GitHub Pages

```bash
npm run build
npx gh-pages -d dist --nojekyll
```

Команда публикует содержимое `dist/` в ветку `gh-pages`. Затем в репозитории: Settings → Pages →
Source: Deploy from a branch → `gh-pages` / `(root)`. Через минуту игра доступна на
`https://<user>.github.io/<repo>/`.

### Netlify

Проще всего перетащить папку `dist/` на https://app.netlify.com/drop. Через CLI:

```bash
npm run build
npx netlify-cli deploy --dir=dist --prod
```

Если подключать репозиторий к Netlify, укажите Build command `npm run build` и Publish directory `dist`.

### itch.io

```bash
npm run build
cd dist && zip -r ../drift-rally.zip . && cd ..
```

`index.html` должен лежать в корне архива. На itch.io: Create new project → Kind of project: HTML →
загрузите `drift-rally.zip` и отметьте «This file will be played in the browser». Размер окна —
например 1280×720, включите «Fullscreen button». Чтобы клавиатура заработала, игрок сначала кликает
по игре.

## Лицензии ресурсов

- 3D-модели (здания, люди, деревья, кусты, скамейка, фонарь, урна, фонтан, банка и стаканы) —
  [Kenney](https://kenney.nl), лицензия [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
  Указание автора не требуется; паки и исходные модели перечислены в
  [`public/models/LICENSES.md`](public/models/LICENSES.md).
- Машина, трасса, велосипед, кроссовок, клумбы и прочая мелочь строятся процедурно в коде игры.
- Шрифты [Unbounded](https://fonts.google.com/specimen/Unbounded) и
  [Manrope](https://fonts.google.com/specimen/Manrope) (пакеты `@fontsource`) — SIL Open Font License 1.1.
- [three.js](https://threejs.org/) — MIT.
- Звук синтезируется в браузере, аудиофайлов нет.
