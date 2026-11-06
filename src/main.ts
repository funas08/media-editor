// エントリーポイント
import './style.css';
import './tools';
import { App } from './ui/App';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('#app が見つかりません');
new App(root);
