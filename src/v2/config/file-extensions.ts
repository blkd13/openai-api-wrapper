// src/config/file-extensions.ts

/**
 * List of audio file extensions
 */
export const audioExtensions = [
    'wav', 'mp3', 'aac', 'flac', 'alac', 'ogg', 'ape', 'dts', 'ac3',
    'm4a', 'm4b', 'm4p', 'mka', 'aiff', 'aif', 'au', 'snd', 'voc',
    'wma', 'ra', 'ram', 'caf', 'tta', 'shn', 'dff', 'dsf', 'atrac',
    'atrac3', 'atrac3plus'
];

/**
 * List of video file extensions
 */
export const videoExtensions = [
    'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'ogv', 'mpg',
    'mpeg', 'm4v', '3gp', '3g2', 'asf', 'dv', 'mxf', 'vob', 'ifo',
    'rm', 'rmvb', 'swf'
];

/**
 * List of image file extensions
 */
export const imageExtensions = [
    'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'svg', 'webp',
    'ico', 'cur', 'ani', 'psd', 'ai', 'eps', 'cdr', 'pcx', 'pnm',
    'pbm', 'pgm', 'ppm', 'ras', 'xbm', 'xpm'
];

/**
 * List of plain text and code file extensions
 */
export const plainExtensions = [
    // Programming languages
    'js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx', 'java', 'c',
    'cpp', 'cs', 'php', 'py', 'python', 'ipynb', 'pc', 'cob', 'cbl',
    'pco', 'copy', 'cpy', 'rb', 'ruby', 'swift', 'go', 'rust', 'sql',
    'pl', 'pm', 'tcl', 'tk', 'lua', 'luau', 'kt', 'ddl', 'awk', 'vb',
    'vbs', 'vbnet', 'asp', 'aspx', 'jsp', 'jspx',

    // Web and markup
    'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'xml',
    'xhtml', 'xslt', 'xsd', 'xsl', 'wsdl',

    // Shell and scripting
    'bash', 'sh', 'zsh', 'ksh', 'csh', 'tcsh', 'perl',

    // Other languages
    'coffee', 'dart', 'elixir', 'erlang', 'groovy', 'haskell',
    'kotlin', 'latex', 'matlab', 'objective-c', 'pascal', 'prolog',
    'r', 'scala', 'verilog', 'vhdl', 'asm', 's', 'S', 'inc',

    // Headers and implementation files
    'h', 'hpp', 'hxx', 'cxx', 'cc', 'cpp', 'c++', 'm', 'mm',

    // Build and configuration
    'makefile', 'cmake', 'gradle', 'pom', 'podfile', 'Gemfile',
    'requirements', 'package',

    // Data formats
    'yaml', 'yml', 'json', 'toml', 'ini', 'conf', 'cfg', 'properties',
    'prop', 'xml', 'xsd', 'xsl', 'xslt',

    // Text and documentation
    'txt', 'text', 'log', 'md', 'markdown', 'rst', 'restructuredtext',
    'csv', 'tsv', 'tab', 'diff', 'patch'
];

/**
 * List of plain text MIME types
 */
export const plainMime = [
    'application/json',
    'application/manifest+json',
    'application/xml',
    'application/x-yaml',
    'application/x-toml',
    'application/yaml',
    'application/toml',
    'application/csv',
    'application/x-ndjson',
    'application/javascript',
    'application/x-typescript',
    'application/sql',
    'application/graphql',
    'application/x-sh',
    'application/x-python',
    'application/x-ipynb+json',
    'application/x-ruby',
    'application/x-php',
    'application/x-latex',
    'application/x-troff',
    'application/x-tex',
    'application/x-www-form-urlencoded',
    'application/ld+json',
    'application/vnd.api+json',
    'application/problem+json',
    'application/rtf',
    'application/x-sql',
    'application/xhtml+xml',
    'application/rss+xml',
    'application/atom+xml',
    'application/x-tcl',
    'application/x-lisp',
    'application/x-r',
    'application/postscript',
    'application/vnd.google-earth.kml+xml',
    'application/x-bash',
    'application/x-csh',
    'application/x-scala',
    'application/x-kotlin',
    'application/x-swift',
    'application/x-plist',
    'application/vnd.apple.mpegurl',
    'application/x-apple-diskimage',
    'application/x-objc',
    'application/vnd.apple.pkpass',
    'application/x-darwin-app',
    'application/pem-certificate-chain',
    'application/x-x509-ca-cert',
    'application/x-ns-proxy-autoconfig',
    'image/svg',
    'image/svg+xml',
    'application/xaml+xml',
    'application/x-perl',
];

/**
 * List of disabled MIME types that should not be processed
 */
export const disabledMimeList = [
    'application/octet-stream',
    'application/java-vm',
    'application/x-elf',
    'application/x-msdownload',
    'application/gzip',
    'application/zip',
    'application/zstd',
    'application/x-gzip',
    'application/x-tar',
    'application/x-bzip2',
    'application/x-xz',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'application/x-compress',
    'image/x-icon',
    'application/font-woff',
    'application/vnd.ms-fontobject',
    'font/woff',
    'font/woff2',
    'font/ttf',
    'font/otf',
    'font/eot',
    'font/collection',
    'application/x-font-ttf',
    'application/x-font-otf',
    'application/x-font-woff',
    'font/sfnt',
    'application/pem-certificate-chain',
    'application/x-x509-ca-cert',
    'application/x-ms-application',
    'application/x-pkcs12',
    'application/pkix-cert',
    'application/x-sqlite3',
    'application/x-cfb',
];

/**
 * List of filenames that should not be processed (usually because they're too large or not useful)
 */
export const disabledFilenameList = [
    'package-lock.json',
    'yarn.lock',
    'go.sum',
];

/**
 * List of directory names that should not be processed
 */
export const disabledDirectoryList = [
    '.git',
    '.vscode',
    'node_modules',
    '.svn',
    '.idea',
    '.vs',
    '.hg',
    '.bzr',
    '__pycache__',
];

/**
 * Map of file extensions to syntax highlighting language identifiers
 */
export const extensionLanguageMap: Record<string, string> = {
    // ----------------------------------
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    cpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    kt: 'kotlin',
    php: 'php',

    // markdown / markup
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',

    // shell
    sh: 'shell',
    bash: 'bash',
    zsh: 'zsh',
    ps: 'powershell',

    // data formats
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    toml: 'toml',

    // SQL
    sql: 'sql',
    psql: 'postgresql',
    mysql: 'mysql',

    // configuration
    conf: 'conf',
    ini: 'ini',
    env: 'env',

    // ----------------------------------
    docker: 'dockerfile',
    makefile: 'makefile',
    gitignore: 'gitignore',
    diff: 'diff',
    tex: 'latex',
    graphql: 'graphql',

    // ----------------------------------
    htm: 'html',
    // XML
    xhtml: 'xml',

    // ----------------------------------
    // JavaScript / TypeScript
    // ----------------------------------
    cjs: 'javascript', // CommonJS
    mjs: 'javascript', // ES Modules
    jsx: 'javascript', // React
    tsx: 'typescript', // React

    // ----------------------------------
    // frontend
    // ----------------------------------
    vue: 'vue',
    svelte: 'svelte',

    // ----------------------------------
    // markdown / markup
    // ----------------------------------
    mdx: 'mdx',
    markdown: 'markdown',

    // C
    c: 'c',
    h: 'c',
    cxx: 'cpp',
    cc: 'cpp',
    hpp: 'cpp', // C++
    hh: 'cpp',
    hxx: 'cpp',

    // Java
    kts: 'kotlin',

    // Swift / Objective-C
    m: 'objectivec',
    mm: 'objectivec', // Objective-C++

    // etc.
    dart: 'dart',
    scala: 'scala',
    groovy: 'groovy',
    lua: 'lua',

    fish: 'fish',

    // PowerShell
    ps1: 'powershell',
    psm1: 'powershell',
    psd1: 'powershell',

    // ----------------------------------
    r: 'r',
    rmd: 'r',

    // ----------------------------------
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    fs: 'fsharp',  // F#
    fsx: 'fsharp',
    fsi: 'fsharp',
    ml: 'ocaml',
    mli: 'ocaml',
    clj: 'clojure',
    cljs: 'clojure',
    coffee: 'coffeescript',
    sc: 'scala',

    // ----------------------------------
    vb: 'vbnet',      // Visual Basic
    pl: 'perl',
    pm: 'perl',       // Perl Module
    csproj: 'xml',    // C# Project File
};