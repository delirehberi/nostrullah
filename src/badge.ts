/**
 * Interactive Nostr Community Pill Badge
 *
 * Supports smooth language transitions and auto-cycling across EN, TR, and ES.
 * Allows instant manual switching via language pills.
 * Clicking the badge/text navigates to https://nostr.org.tr.
 */

export type SupportedLanguage = 'EN' | 'TR' | 'ES';

export interface BadgeLanguageContent {
    code: SupportedLanguage;
    label: string;
    text: string;
    ariaLabel: string;
}

export const BADGE_COMMUNITY_URL = 'https://nostr.org.tr';

export const BADGE_LANGUAGES: Record<SupportedLanguage, BadgeLanguageContent> = {
    EN: {
        code: 'EN',
        label: 'EN',
        text: 'A nostr.org.tr community initiative',
        ariaLabel: 'English: A nostr.org.tr community initiative',
    },
    TR: {
        code: 'TR',
        label: 'TR',
        text: 'Bir nostr.org.tr topluluk girişimidir',
        ariaLabel: 'Türkçe: Bir nostr.org.tr topluluk girişimidir',
    },
    ES: {
        code: 'ES',
        label: 'ES',
        text: 'Una iniciativa comunitaria de nostr.org.tr',
        ariaLabel: 'Español: Una iniciativa comunitaria de nostr.org.tr',
    },
};

export const LANGUAGE_ORDER: SupportedLanguage[] = ['EN', 'TR', 'ES'];

export const BADGE_STYLES = `
:host {
    display: inline-block;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    --badge-bg: rgba(24, 24, 27, 0.85);
    --badge-hover-bg: rgba(39, 39, 42, 0.95);
    --badge-border: rgba(255, 255, 255, 0.12);
    --badge-border-hover: rgba(168, 85, 247, 0.4);
    --badge-text: #f4f4f5;
    --badge-text-dim: #a1a1aa;
    --badge-highlight: #c084fc;
    --pill-bg: rgba(255, 255, 255, 0.07);
    --pill-active-bg: #9333ea;
    --pill-active-text: #ffffff;
    --pill-hover-bg: rgba(255, 255, 255, 0.15);
    --pill-text: #d4d4d8;
    --badge-shadow: 0 4px 12px -2px rgba(0, 0, 0, 0.3), 0 0 0 1px var(--badge-border);
    --badge-glow: 0 0 20px -3px rgba(168, 85, 247, 0.25);
    box-sizing: border-box;
}

:host([theme="light"]) {
    --badge-bg: rgba(255, 255, 255, 0.9);
    --badge-hover-bg: #ffffff;
    --badge-border: rgba(0, 0, 0, 0.08);
    --badge-border-hover: rgba(147, 51, 234, 0.35);
    --badge-text: #18181b;
    --badge-text-dim: #71717a;
    --badge-highlight: #7e22ce;
    --pill-bg: rgba(0, 0, 0, 0.05);
    --pill-active-bg: #9333ea;
    --pill-active-text: #ffffff;
    --pill-hover-bg: rgba(0, 0, 0, 0.1);
    --pill-text: #52525b;
    --badge-shadow: 0 4px 12px -2px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--badge-border);
    --badge-glow: 0 0 18px -2px rgba(168, 85, 247, 0.15);
}

@media (prefers-color-scheme: light) {
    :host(:not([theme="dark"]):not([theme="light"])) {
        --badge-bg: rgba(255, 255, 255, 0.9);
        --badge-hover-bg: #ffffff;
        --badge-border: rgba(0, 0, 0, 0.08);
        --badge-border-hover: rgba(147, 51, 234, 0.35);
        --badge-text: #18181b;
        --badge-text-dim: #71717a;
        --badge-highlight: #7e22ce;
        --pill-bg: rgba(0, 0, 0, 0.05);
        --pill-active-bg: #9333ea;
        --pill-active-text: #ffffff;
        --pill-hover-bg: rgba(0, 0, 0, 0.1);
        --pill-text: #52525b;
        --badge-shadow: 0 4px 12px -2px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--badge-border);
        --badge-glow: 0 0 18px -2px rgba(168, 85, 247, 0.15);
    }
}

* {
    box-sizing: border-box;
}

.badge-wrapper {
    display: inline-flex;
    align-items: center;
    position: relative;
    background: var(--badge-bg);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-radius: 9999px;
    padding: 4px 6px 4px 10px;
    box-shadow: var(--badge-shadow);
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    border: 1px solid var(--badge-border);
    user-select: none;
    max-width: 100%;
}

.badge-wrapper:hover {
    background: var(--badge-hover-bg);
    border-color: var(--badge-border-hover);
    box-shadow: var(--badge-shadow), var(--badge-glow);
    transform: translateY(-1px);
}

.badge-link {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    color: var(--badge-text);
    padding: 2px 6px 2px 2px;
    border-radius: 9999px;
    cursor: pointer;
    outline: none;
    min-width: 0;
}

.badge-link:focus-visible {
    outline: 2px solid var(--badge-highlight);
    outline-offset: 2px;
}

.nostr-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
    color: #ffffff;
    flex-shrink: 0;
    box-shadow: 0 2px 6px rgba(168, 85, 247, 0.3);
}

.nostr-icon svg {
    width: 11px;
    height: 11px;
    fill: currentColor;
}

.badge-text-container {
    position: relative;
    display: inline-flex;
    align-items: center;
    overflow: hidden;
    white-space: nowrap;
    font-weight: 500;
    letter-spacing: -0.01em;
}

.badge-text {
    display: inline-block;
    transition: opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1), transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    opacity: 1;
    transform: translateY(0);
}

.badge-text.fade-out {
    opacity: 0;
    transform: translateY(-6px);
}

.badge-text.fade-in {
    opacity: 0;
    transform: translateY(6px);
}

.badge-text .domain {
    color: var(--badge-highlight);
    font-weight: 600;
}

.language-pills {
    display: inline-flex;
    align-items: center;
    background: var(--pill-bg);
    border-radius: 9999px;
    padding: 2px;
    margin-left: 8px;
    gap: 2px;
    position: relative;
}

.lang-btn {
    background: transparent;
    border: none;
    color: var(--pill-text);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 3px 7px;
    border-radius: 9999px;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    outline: none;
    line-height: 1.2;
}

.lang-btn:hover:not(.active) {
    background: var(--pill-hover-bg);
    color: var(--badge-text);
}

.lang-btn:focus-visible {
    outline: 2px solid var(--badge-highlight);
    outline-offset: 1px;
}

.lang-btn.active {
    background: var(--pill-active-bg);
    color: var(--pill-active-text);
    box-shadow: 0 1px 4px rgba(147, 51, 234, 0.4);
}

@media (prefers-reduced-motion: reduce) {
    .badge-wrapper,
    .badge-text,
    .lang-btn {
        transition: none !important;
        transform: none !important;
    }
}
`;

export function getNextLanguage(current: SupportedLanguage): SupportedLanguage {
    const currentIndex = LANGUAGE_ORDER.indexOf(current);
    const nextIndex = (currentIndex + 1) % LANGUAGE_ORDER.length;
    return LANGUAGE_ORDER[nextIndex];
}

export function formatBadgeText(text: string): string {
    return text.replace('nostr.org.tr', '<span class="domain">nostr.org.tr</span>');
}

export function getLanguageContent(lang: SupportedLanguage): BadgeLanguageContent {
    return BADGE_LANGUAGES[lang] || BADGE_LANGUAGES.EN;
}

export function renderBadgeHtml(initialLang: SupportedLanguage = 'EN'): string {
    const content = getLanguageContent(initialLang);
    return `
        <div class="nostr-badge-wrapper" role="region" aria-label="nostr.org.tr community badge">
            <a class="nostr-badge-link" 
               href="${BADGE_COMMUNITY_URL}" 
               target="_blank" 
               rel="noopener noreferrer"
               title="Visit nostr.org.tr">
                <span class="nostr-badge-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14.5h-2v-2h2v2zm0-4h-2V7h2v5.5z"/>
                    </svg>
                </span>
                <span class="nostr-badge-text-container" aria-live="polite">
                    <span class="nostr-badge-text" aria-label="${content.ariaLabel}">
                        ${formatBadgeText(content.text)}
                    </span>
                </span>
            </a>
            <div class="nostr-language-pills" role="group" aria-label="Language selection">
                ${LANGUAGE_ORDER.map(
                    (lang) => `
                    <button type="button" 
                            class="nostr-lang-btn ${lang === initialLang ? 'active' : ''}" 
                            data-lang="${lang}"
                            aria-label="Switch to ${BADGE_LANGUAGES[lang].ariaLabel}"
                            aria-pressed="${lang === initialLang ? 'true' : 'false'}">
                        ${BADGE_LANGUAGES[lang].label}
                    </button>
                `
                ).join('')}
            </div>
        </div>
    `.trim();
}

const CustomElementBase = (
    typeof HTMLElement !== 'undefined' ? HTMLElement : class {}
) as typeof HTMLElement;

export class NostrCommunityBadge extends CustomElementBase {
    private shadowRootNode?: ShadowRoot | Element | MockShadowHost;
    private currentLang: SupportedLanguage = 'EN';
    private cycleTimer: ReturnType<typeof setInterval> | null = null;
    private isPaused: boolean = false;
    private intervalMs: number = 4000;
    private autoCycleEnabled: boolean = true;

    private textEl: HTMLElement | null = null;
    private linkEl: HTMLElement | null = null;
    private langButtons: Map<SupportedLanguage, HTMLElement> = new Map();

    static get observedAttributes() {
        return ['initial-lang', 'auto-cycle', 'interval', 'theme'];
    }

    constructor() {
        super();
        if (typeof (this as any).attachShadow === 'function') {
            this.shadowRootNode = (this as any).attachShadow({ mode: 'open' });
        }
    }

    connectedCallback() {
        this.readAttributes();
        this.render();
        this.setupEvents();
        if (this.autoCycleEnabled) {
            this.startAutoCycle();
        }
    }

    disconnectedCallback() {
        this.stopAutoCycle();
    }

    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
        if (oldValue === newValue) return;

        if (name === 'initial-lang' && newValue) {
            const normalized = newValue.toUpperCase() as SupportedLanguage;
            if (BADGE_LANGUAGES[normalized]) {
                this.setLanguage(normalized, false);
            }
        } else if (name === 'auto-cycle') {
            this.autoCycleEnabled = newValue !== 'false';
            if (this.autoCycleEnabled) {
                this.startAutoCycle();
            } else {
                this.stopAutoCycle();
            }
        } else if (name === 'interval' && newValue) {
            const parsed = parseInt(newValue, 10);
            if (!isNaN(parsed) && parsed >= 1000) {
                this.intervalMs = parsed;
                if (this.autoCycleEnabled) {
                    this.restartAutoCycle();
                }
            }
        }
    }

    private readAttributes() {
        const langAttr = this.getAttribute('initial-lang');
        if (langAttr) {
            const upper = langAttr.toUpperCase() as SupportedLanguage;
            if (BADGE_LANGUAGES[upper]) {
                this.currentLang = upper;
            }
        }

        const autoCycleAttr = this.getAttribute('auto-cycle');
        if (autoCycleAttr !== null) {
            this.autoCycleEnabled = autoCycleAttr !== 'false';
        }

        const intervalAttr = this.getAttribute('interval');
        if (intervalAttr) {
            const parsed = parseInt(intervalAttr, 10);
            if (!isNaN(parsed) && parsed >= 1000) {
                this.intervalMs = parsed;
            }
        }
    }

    public getLanguage(): SupportedLanguage {
        return this.currentLang;
    }

    public setLanguage(lang: SupportedLanguage, restartTimer: boolean = true) {
        if (!BADGE_LANGUAGES[lang]) return;
        if (this.currentLang === lang && this.textEl && this.textEl.innerHTML.trim() !== '') {
            return;
        }

        const prevLang = this.currentLang;
        this.currentLang = lang;
        this.updateActiveButton();

        if (this.textEl) {
            this.textEl.classList.add('fade-out');
            setTimeout(() => {
                if (!this.textEl) return;
                this.textEl.innerHTML = this.formatBadgeText(BADGE_LANGUAGES[lang].text);
                this.textEl.setAttribute('aria-label', BADGE_LANGUAGES[lang].ariaLabel);
                this.textEl.classList.remove('fade-out');
                this.textEl.classList.add('fade-in');

                requestAnimationFrame(() => {
                    if (!this.textEl) return;
                    this.textEl.classList.remove('fade-in');
                });
            }, 180);
        }

        this.dispatchEvent(
            new CustomEvent('languagechange', {
                detail: {
                    language: lang,
                    previousLanguage: prevLang,
                    text: BADGE_LANGUAGES[lang].text,
                },
                bubbles: true,
                composed: true,
            })
        );

        if (restartTimer && this.autoCycleEnabled) {
            this.restartAutoCycle();
        }
    }

    public nextLanguage() {
        const currentIndex = LANGUAGE_ORDER.indexOf(this.currentLang);
        const nextIndex = (currentIndex + 1) % LANGUAGE_ORDER.length;
        this.setLanguage(LANGUAGE_ORDER[nextIndex], false);
    }

    private formatBadgeText(text: string): string {
        return text.replace('nostr.org.tr', '<span class="domain">nostr.org.tr</span>');
    }

    private updateActiveButton() {
        this.langButtons.forEach((btn, lang) => {
            const isActive = lang === this.currentLang;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    private startAutoCycle() {
        this.stopAutoCycle();
        this.cycleTimer = setInterval(() => {
            if (!this.isPaused) {
                this.nextLanguage();
            }
        }, this.intervalMs);
    }

    private stopAutoCycle() {
        if (this.cycleTimer !== null) {
            clearInterval(this.cycleTimer);
            this.cycleTimer = null;
        }
    }

    private restartAutoCycle() {
        this.startAutoCycle();
    }

    private get rootNode(): any {
        return this.shadowRootNode || (this as any).shadowRoot || this;
    }

    private render() {
        const currentContent = BADGE_LANGUAGES[this.currentLang];

        this.rootNode.innerHTML = `
            <style>${BADGE_STYLES}</style>
            <div class="badge-wrapper" part="wrapper" role="region" aria-label="nostr.org.tr community badge">
                <a class="badge-link" 
                   part="link" 
                   href="${BADGE_COMMUNITY_URL}" 
                   target="_blank" 
                   rel="noopener noreferrer"
                   title="Visit nostr.org.tr">
                    <span class="nostr-icon" part="icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14.5h-2v-2h2v2zm0-4h-2V7h2v5.5z"/>
                        </svg>
                    </span>
                    <span class="badge-text-container" part="text-container" aria-live="polite">
                        <span class="badge-text" part="text" aria-label="${currentContent.ariaLabel}">
                            ${this.formatBadgeText(currentContent.text)}
                        </span>
                    </span>
                </a>
                <div class="language-pills" part="pills" role="group" aria-label="Language selection">
                    ${LANGUAGE_ORDER.map(
                        (lang) => `
                        <button type="button" 
                                class="lang-btn ${lang === this.currentLang ? 'active' : ''}" 
                                data-lang="${lang}"
                                part="lang-btn lang-btn-${lang.toLowerCase()}"
                                aria-label="Switch to ${BADGE_LANGUAGES[lang].ariaLabel}"
                                aria-pressed="${lang === this.currentLang ? 'true' : 'false'}">
                            ${BADGE_LANGUAGES[lang].label}
                        </button>
                    `
                    ).join('')}
                </div>
            </div>
        `;

        this.textEl = this.rootNode.querySelector('.badge-text');
        this.linkEl = this.rootNode.querySelector('.badge-link');

        this.langButtons.clear();
        this.rootNode.querySelectorAll('.lang-btn').forEach((btn: any) => {
            const lang = btn.getAttribute('data-lang') as SupportedLanguage;
            if (lang) {
                this.langButtons.set(lang, btn);
            }
        });
    }

    private setupEvents() {
        const wrapper = this.rootNode.querySelector('.badge-wrapper');
        if (wrapper) {
            wrapper.addEventListener('mouseenter', () => {
                this.isPaused = true;
            });
            wrapper.addEventListener('mouseleave', () => {
                this.isPaused = false;
            });
            wrapper.addEventListener('focusin', () => {
                this.isPaused = true;
            });
            wrapper.addEventListener('focusout', () => {
                this.isPaused = false;
            });
        }

        this.langButtons.forEach((btn, lang) => {
            btn.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                e.preventDefault();
                this.setLanguage(lang, true);
            });
        });
    }
}

// Auto-register custom element in browser environments
if (typeof window !== 'undefined' && typeof customElements !== 'undefined') {
    if (!customElements.get('nostr-community-badge')) {
        customElements.define('nostr-community-badge', NostrCommunityBadge);
    }
}
