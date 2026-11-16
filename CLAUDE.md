# Skarbiec: zasady dla Claude

Opis funkcji, uruchamianie i struktura katalogów: README.md. Tu są tylko reguły, których nie widać od razu w kodzie.

## Praca

- Commity po polsku, w trybie rozkazującym („Dodaj…”, „Popraw…”), z opisem zmian w treści.
- Wyjątek: GitHub Actions (`.github/workflows/`) po angielsku: nazwy plików, workflowów, jobów, kroków,
  komunikaty i opis wydania.
- Każda zmiana z testem: logika w `test/*.test.js`, interfejs w `test/e2e.test.js`. Przed commitem `npm run test:all`.
- Nigdy nie commituj prawdziwych danych: raportów XTB, pliku `skarbiec.json`, numerów rachunków, kwot.
  Pliki XLSX w testach mają wymyślone dane i generuje je `python3 test/fixtures/make_xtb_fixtures.py`.

## Architektura

- Obliczenia wyłącznie w modułach bez DOM i I/O (`portfolio.js`, `valuation.js`, `bonds.js`, `market.js`,
  `xtb.js`, `xlsx.js`). `main.js` to tylko interfejs. Sieć wstrzykiwana jako `fetch`, żeby dało się testować.
- Brak zależności npm w działającej aplikacji (`playwright-core` jest tylko do testów).
- Nowy adres sieciowy: dopisz go do `src-tauri/capabilities/default.json`. CSP blokuje zewnętrzne skrypty, style
  i atrybuty `style`; style ustawiaj przez `element.style` (helper `el()` w `main.js`).
- Dane użytkownika do DOM tylko przez `textContent`, nigdy `innerHTML`.
- Zapis danych: zawsze przez `persist()` (kolejkuje zapisy). Rust odrzuca niepoprawny JSON i zapisuje atomowo.
- Zgodność pliku danych: nowe pola dostają wartości domyślne w `EMPTY` w `main.js`; starych danych nie odrzucaj.
  Identyfikator `pl.local.skarbiec` i nazwa pliku `skarbiec.json` wyznaczają miejsce danych: nie zmieniaj ich.
- Kolory części portfela są przypisane do części na stałe (`allocation()` w `valuation.js`). Nowa część dostaje
  następny kolor na końcu; paletę sprawdź walidatorem z umiejętności dataviz w obu motywach.
- Wpłaty i limit tylko dla OIPE (`DEPOSIT_ACCOUNTS`): Finax nie ma eksportu i wymienia walutę po swoim kursie.
  Konta XTB mają dokładny koszt z importu (kurs z Cash Operations), więc wpłat tam nie dodawaj.
- Kursy: Yahoo `v8/finance/chart` (nieoficjalny) i NBP. Niemieckie ETF-y wyceniaj z XETRA (`.DE`);
  notowania `.F` w Yahoo są nieaktualne.

## Coroczna obsługa

- Styczeń: limit OIPE na nowy rok w `LIMITS` w `src/valuation.js`.
- Obligacje ROR liczone według listu emisyjnego 104/2026 (`src/bonds.js`). Przy nowych seriach sprawdź, czy zasady
  (opłata za wykup, wzór odsetek, dzień stopy NBP) się nie zmieniły.

## Wydania

- Wersja jest w trzech miejscach: `src-tauri/tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml`; zmieniaj
  wszystkie naraz (lockfile'y aktualizuj przez npm/cargo). Tag `vX.Y.Z` musi być równy tej wersji, inaczej
  workflow „Release” się zatrzyma.

## Testy interfejsu

- `test/e2e.test.js`: prawdziwy `src/` w Chrome przez `playwright-core`, atrapa Tauri (`fakeTauri`) z plikiem danych
  w pamięci i stałymi kursami, zegar ustawiony na 2026-11-15 12:00 czasu warszawskiego.
- Polski format liczb używa spacji nierozdzielającej (`\u00a0`) jako separatora tysięcy.
