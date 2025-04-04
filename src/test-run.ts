import { aiApi } from './v2/index.js';

// Simple completion stream
aiApi.chatCompletionStream({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello, world!' }]
}).subscribe({
    next: (chunk) => console.log(chunk.choices[0]?.delta?.content || ''),
    error: (err) => console.error('Error:', err),
    complete: () => console.log('Stream complete')
});

// // With provider override
// aiApi.chatCompletionStream({
//     model: 'gpt-4o',
//     messages: [{ role: 'user', content: 'Hello, world!' }]
// }, {
//     provider: 'openai'
// }).subscribe({
//     next: (chunk) => console.log(chunk.choices[0]?.delta?.content || ''),
//     error: (err) => console.error('Error:', err),
//     complete: () => console.log('Stream complete')
// });