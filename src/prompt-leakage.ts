export interface PromptLeakageCheckResult {
    isLeaked: boolean;
    reason?: string;
}

const COMMON_META_PATTERNS = [
    'here is a post',
    "here's a post",
    'here is the post',
    "here's the post",
    'here is an engaging post',
    'here is a short',
    'işte bir gönderi',
    'işte gönderiniz',
    'sosyal medya gönderisi:',
    'lütfen ulaştığınız',
    'lütfen aşağıdaki',
    'aşağıdaki açıklamaları gerçekleştirin',
    'haberi özgün bir şekilde yorumlayıp',
    'bunun dışındaki tüm diğer konuları da analiz edebilirsiniz',
];

/**
 * Checks whether generated post content leaks meta-instructions or echoes parts of the prompt template.
 */
export function detectPromptLeakage(
    content: string,
    promptTemplate?: string
): PromptLeakageCheckResult {
    const normalizedContent = content.toLowerCase().replace(/\s+/g, ' ').trim();

    // 1. Check for common meta/instructional preamble phrases
    for (const pattern of COMMON_META_PATTERNS) {
        if (normalizedContent.includes(pattern)) {
            return {
                isLeaked: true,
                reason: `Draft contains meta/instructional phrase: "${pattern}"`,
            };
        }
    }

    if (!promptTemplate) {
        return { isLeaked: false };
    }

    // 2. Extract substantial non-placeholder instruction fragments from the prompt template
    const sanitizedTemplate = promptTemplate
        .replace(/\$\$[A-Z_]+\$\$/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ');

    // Split template into clauses / lines (at least 20 chars)
    const fragments = sanitizedTemplate
        .split(/[\n\r.!?•-]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 20);

    for (const fragment of fragments) {
        const normalizedFragment = fragment.toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalizedFragment.length >= 20 && normalizedContent.includes(normalizedFragment)) {
            return {
                isLeaked: true,
                reason: `Draft echoes prompt template instructions: "${fragment.slice(0, 45)}..."`,
            };
        }
    }

    return { isLeaked: false };
}
