export const source = `
{
  "name": "{{projectName}}",
  "version": "0.0.0",
  "scripts": {
    "ng": "ng",
    "start": "ng serve --proxy-config proxy.conf.js --host 0.0.0.0 --disable-host-check --serve-path /{{projectName}}/",
    "build": "ng build --base-href /{{projectName}}/",
    "watch": "ng build --watch --configuration development",
    "test": "ng test"
  },
  "private": true,
  "dependencies": {
    "@angular/animations": "^17.0.3",
    "@angular/cdk": "~17.0.0",
    "@angular/common": "^17.0.3",
    "@angular/compiler": "^17.0.3",
    "@angular/core": "^17.0.3",
    "@angular/forms": "^17.0.3",
    "@angular/material": "~17.0.0",
    "@angular/platform-browser": "^17.0.3",
    "@angular/platform-browser-dynamic": "^17.0.3",
    "@angular/router": "^17.0.3",
    "autoprefixer": "^10.4.16",
    "emoji-toolkit": "^8.0.0",
    "katex": "^0.16.0",
    "postcss": "^8.4.31",
    "rxjs": "~7.8.0",
    "tailwindcss": "^3.3.5",
    "tslib": "^2.3.0",
    "uuid": "^9.0.1",
    "zone.js": "~0.14.2"
  },
  "devDependencies": {
    "@angular-devkit/build-angular": "^17.0.1",
    "@angular/cli": "~17.0.1",
    "@angular/compiler-cli": "^17.0.3",
    "@types/jasmine": "~4.3.0",
    "jasmine-core": "~4.6.0",
    "karma": "~6.4.0",
    "karma-chrome-launcher": "~3.2.0",
    "karma-coverage": "~2.2.0",
    "karma-jasmine": "~5.1.0",
    "karma-jasmine-html-reporter": "~2.1.0",
    "typescript": "~5.2.2"
  }
}
`;

export default source.trim();