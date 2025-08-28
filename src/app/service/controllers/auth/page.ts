export function redirectingPage(redirectUri: string) {
    return `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>redirecting…</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <!-- OSのダーク/ライトに合わせてフォーム等のUIも適応 -->
  <meta name="color-scheme" content="light dark" />

  <!-- 1) できるだけ早くテーマを決定（localStorage優先、なければOS設定） -->
  <script>
    (function () {
      try {
        var t = localStorage.getItem('theme'); // 'light' | 'dark' | 'system' | null
        if (t === 'dark' || (t !== 'light' && matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)) {
          document.documentElement.setAttribute('data-theme', 'dark');
        } else if (t === 'light') {
          document.documentElement.setAttribute('data-theme', 'light');
        }
      } catch (e) {}
      // 2) 履歴を汚さないリダイレクト
      var dest = '${redirectUri}';
      if (dest) location.replace(dest);
    })();
  </script>

  <!-- JS無効時や競合時のフォールバック -->
  <meta http-equiv="refresh" content="0; URL=${redirectUri}" />

  <style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; }
    body {
      margin: 0;
      display: grid;
      place-items: center;
      font: 14px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #fff; color: #111;
    }
    /* 明示テーマ（localStorage適用時） */
    html[data-theme="dark"] body { background: #111; color: #eee; }
    html[data-theme="light"] body { background: #fff; color: #111; }

    /* 明示テーマなしはOS設定に従う */
    @media (prefers-color-scheme: dark) {
      html:not([data-theme]) body { background: #111; color: #eee; }
    }
  </style>
</head>
<body>
  <p>Redirecting…</p>
</body>
</html>
`;
}