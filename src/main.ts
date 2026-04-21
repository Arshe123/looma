import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { createPinia } from 'pinia'

// 创建Vue应用实例
const app = createApp(App)

const pinia = createPinia()

app.use(pinia)

// 挂载应用
app.mount('#app')
