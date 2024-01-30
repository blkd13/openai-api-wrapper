export const source = `
import { Injectable } from '@angular/core';
import { HttpErrorResponse, HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { Observable, catchError, finalize, throwError } from 'rxjs';
import { environment } from 'src/environments/environment';
import { GService } from './services/g.service';
import { Router } from '@angular/router';

@Injectable()
export class ApiInterceptor implements HttpInterceptor {

    private httpConnectCount = 0;
    // private lastRun: number = Date.now();
    constructor(
        private g: GService,
        private router: Router,
    ) {
    }

    intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
        let url;
        // パスだけ取得？
        // let url = request.url.replace(/https?:\\/\\/[^/]+/g, '').replace('//', '/').replace(/^\\//g, '');
        let method = request.method;
        // console.log(\`\${method} \${url}\`);
        // 開発環境の場合はローカルのjsonファイルに向ける
        // !environment.production ||
        if (this.g.queries['isMock']) {
            url = request.url.replace(/https?:\\/\\/[^/]+/g, '').replace('//', '/').replace(/^\\//g, '').replace(/\\/$/, '');
            url = \`assets/mock/api/\${url}-\${request.method}.json\`;
            method = 'GET';
        } else {
            // 本番環境の場合は環境変数で指定したAPIのエンドポイントに向ける
            if (request.url.startsWith('https://api.openai.com')) {
                url = request.url;
            } else {
                url = \`\${environment.apiUrl}/\${request.url}\`;
            }
        }
        request = request.clone({ url, method });

        // // 同時リクエストが多くなるとブラウザエラーになることがあったので適当に遅延させる機能を付けた
        // // pipe(delay)だと結果読み出しが遅延するだけで発射が遅延しないのでsetTimeoutを使う
        // let delayTime = 0;
        // if (Date.now() - this.lastRun < 10) {
        //     delayTime = Math.random() * 0;
        //     // console.log(\`delay \${delayTime}[ms]\`); // tslint:disable-line:no-console
        // } else { }
        // this.lastRun = Date.now();
        // return of(null).pipe(
        //     delayWhen(() => timer(delayTime)),    // リクエストの発射を遅らせる
        //     switchMap(() => next.handle(request)) // 実際のリクエストを処理
        // );
        // 手間だけど結局settimeoutで遅延させるのが一番確実
        // return new Observable<HttpEvent<any>>((observer) => {
        //     setTimeout(() => {
        //         next.handle(request).subscribe({
        //             next: (event) => { observer.next(event); },
        //             error: (err) => { observer.error(err); },
        //             complete: () => { observer.complete(); },
        //         });
        //     }, delayTime);
        // });

        // ローディング表示をするためにリクエストの開始と終了を通知する
        this.g.httpConnectCount.next(++this.httpConnectCount);
        return next.handle(request)
            .pipe(
                // ログインページにリダイレクトするために401エラーをキャッチする
                catchError((error: HttpErrorResponse) => {
                    if (error.status === 401) {
                        // 未認証の場合、ログインページにリダイレクト
                        this.router.navigate(['/login']);
                    }
                    return throwError(error);
                }),
                finalize(() => {
                    // ローディング表示をするためにリクエストの開始と終了を通知する
                    this.g.httpConnectCount.next(--this.httpConnectCount);
                })
            );
    }
}
`;

export default source.trim();