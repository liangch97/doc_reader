// MUST be first import: patches Promise.withResolvers / Object.groupBy / ...
// for old Android WebView (< Chromium 119). pdfjs-dist 4.x 在 import 顶层就会调用，
// 必须先注入 polyfill 再 import 任何业务模块。
import './lib/androidPolyfills'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'

import App from './App'
import HomePage from './pages/HomePage'
import LibraryPage from './pages/LibraryPage'
import CoursesPage from './pages/CoursesPage'
import CourseWorkspacePage from './pages/CourseWorkspacePage'
import ReaderPage from './pages/ReaderPage'
import NotebookPage from './pages/NotebookPage'
import SettingsPage from './pages/SettingsPage'
import SkillsPage from './pages/SkillsPage'
import TrainingPage from './pages/TrainingPage'

import './styles/globals.css'
import { installAndroidBackHandler } from './lib/androidBack'
import { applyStoredReaderThemeOnBoot } from './features/reader/readerThemes'

// 启动早期就把用户上次选的阅读主题写入 :root，避免首帧"先暗后亮"闪烁。
applyStoredReaderThemeOnBoot()

// Android 系统返回 / 边缘右滑：默认 webview 不会退出 app，需要我们接管。
// 桌面 / iOS 不会执行（内部 isAndroidPlatform 守卫）。
installAndroidBackHandler()

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'courses', element: <CoursesPage /> },
      { path: 'courses/:courseId', element: <CourseWorkspacePage /> },
      { path: 'reader/:resourceId', element: <ReaderPage /> },
      { path: 'notebook', element: <NotebookPage /> },
      { path: 'notebook/:notebookId', element: <NotebookPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'training', element: <TrainingPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
)
