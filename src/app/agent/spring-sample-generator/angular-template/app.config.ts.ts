export const source = `
import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';

import { provideAnimations } from "@angular/platform-browser/animations";
import { HTTP_INTERCEPTORS, provideHttpClient, withInterceptorsFromDi } from "@angular/common/http";

import { routes } from './app.routes';
import { ApiInterceptor } from './api.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideAnimations(),
    provideHttpClient(withInterceptorsFromDi()),
    provideRouter(routes),
    { provide: HTTP_INTERCEPTORS, useClass: ApiInterceptor, multi: true },
    importProvidersFrom(
      // BrowserAnimationsModule,
      // FormsModule,
      // HttpClientModule,
      // CommonModule,
      // RouterModule,
      // AppCommonModule,
    ),
  ],
};
`;
export default source.trim();

// import { Routes } from '@angular/router';

// export const routes: Routes = [
//     { path: '', redirectTo: 'top-menu', pathMatch: 'full' },
//     { path: 'login', loadComponent: () => import('./pages/login/login.component').then(m => m.LoginComponent) },
//     { path: 'top-menu', loadComponent: () => import('./pages/top-menu/top-menu.component').then(m => m.TopMenuComponent) },
//     { path: 'collaboration', loadComponent: () => import('./pages/collaboration/collaboration.component').then(m => m.CollaborationComponent) },
//     { path: 'dashboard', loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.DashboardComponent) },
//     { path: 'help-support', loadComponent: () => import('./pages/help-support/help-support.component').then(m => m.HelpSupportComponent) },
//     { path: 'workflow-builder', loadComponent: () => import('./pages/workflow-builder/workflow-builder.component').then(m => m.WorkflowBuilderComponent) },
//     { path: 'run-task', loadComponent: () => import('./pages/workflow-builder/run-task/run-task.component').then(m => m.RunTaskComponent) },
//     // { path: 'document-model-builder', loadComponent: () => import('./parts/document-model-builder/document-model-builder.component').then(m => m.DocumentModelBuilderComponent) },
//     {
//         path: 'project-creation-edit', loadComponent: () => import('./pages/project-creation-edit/project-creation-edit.component').then(m => m.ProjectCreationEditComponent),
//         children: [
//             { path: 'step01-requirements/:id', loadComponent: () => import('./pages/project-creation-edit/step01-requirements/step01-requirements.component').then(m => m.Step01RequirementsComponent) },
//             { path: 'step02-feature/:id', loadComponent: () => import('./pages/project-creation-edit/step02-feature/step02-feature.component').then(m => m.Step02FeatureComponent) },
//             { path: 'step03-feature-detail/:id', loadComponent: () => import('./pages/project-creation-edit/step03-feature-detail/step03-feature-detail.component').then(m => m.Step03FeatureDetailComponent) },
//             { path: 'step04-bounded-context/:id', loadComponent: () => import('./pages/project-creation-edit/step04-bounded-context/step04-bounded-context.component').then(m => m.Step04BoundedContextComponent) },
//             { path: 'step05-context-mapping/:id', loadComponent: () => import('./pages/project-creation-edit/step05-context-mapping/step05-context-mapping.component').then(m => m.Step05ContextMappingComponent) },
//             { path: 'step06-summary-list/:id', loadComponent: () => import('./pages/project-creation-edit/step06-summary-list/step06-summary-list.component').then(m => m.Step06SummaryListComponent) },
//             { path: 'step07-detail-list/:id', loadComponent: () => import('./pages/project-creation-edit/step07-detail-list/step07-detail-list.component').then(m => m.Step07DetailListComponent) },
//         ]
//     },
//     { path: 'search-exploration', loadComponent: () => import('./pages/search-exploration/search-exploration.component').then(m => m.SearchExplorationComponent) },
//     { path: 'user-settings-profile', loadComponent: () => import('./pages/user-settings-profile/user-settings-profile.component').then(m => m.UserSettingsProfileComponent) }, ,
//     { path: '**', redirectTo: 'login' } // 未定義のルートの場合はログインページにリダイレクトする
// ] as Routes;
