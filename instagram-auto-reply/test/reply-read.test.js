import test from 'node:test';
import assert from 'node:assert/strict';
import { replyReadTargets, inspectReplyRead } from '../src/instagram/reply-read.js';

const id = '18118280044957793';
const response = (edges = [], pageInfo = { has_next_page: false, has_previous_page: false }) => ({ data: {
  xdt_api__v1__media__media_id__comments__parent_comment_id__child_comments__connection: { edges, page_info: pageInfo },
} });

test('associa a leitura ao comentário exato sem arredondar IDs', () => {
  const request = (variables) => ({ postData: () => new URLSearchParams({ variables }).toString() });
  assert.equal(replyReadTargets(request(`{"parent_comment_id":${id},"media_id":"987"}`), id), true);
  assert.equal(replyReadTargets(request('{"parent_comment_id":"18118280044957794"}'), id), false);
  assert.equal(replyReadTargets(request('{"media_id":"18118280044957793"}'), id), false);
  assert.equal(replyReadTargets(request(`{"parent_comment_id":${String(Number(id))}}`), id), false);
});

test('vazio só é confirmado com coleção reconhecida e paginação concluída', () => {
  const empty = inspectReplyRead(response(), 200);
  assert.equal(empty.confirmed, true);
  assert.equal(empty.complete, true);
  assert.equal(empty.empty, true);
  assert.equal(inspectReplyRead({ data: null }, 200).complete, false);
  assert.equal(inspectReplyRead(response([], {}), 200).complete, false);
  assert.equal(inspectReplyRead(response([], { has_next_page: true }), 200).complete, false);
  assert.equal(inspectReplyRead(response([], { has_next_page: false, has_previous_page: true }), 200).complete, false);
});

test('erros de leitura, inclusive GraphQL HTTP 200, não liberam vazio', () => {
  const body = { ...response(), errors: [{ message: 'Rate limit exceeded' }] };
  assert.equal(inspectReplyRead(body, 200).complete, false);
  assert.equal(inspectReplyRead(body, 200).limited, true);
  assert.equal(inspectReplyRead(response(), 429).limited, true);
  assert.equal(inspectReplyRead(response(), 403).complete, false);
  assert.equal(inspectReplyRead({ ...response(), errors: { message: 'failed' } }, 200).complete, false);
});

test('autores não exibidos no DOM são lidos e autor desconhecido impede liberação', () => {
  const body = response([{ node: { user: { username: 'Gabrieltipss' } } }]);
  assert.deepEqual(inspectReplyRead(body, 200).authors, ['gabrieltipss']);
  assert.equal(inspectReplyRead(body, 200).complete, true);
  assert.equal(inspectReplyRead(response([{ node: { user: null } }]), 200).complete, false);
});

test('resposta legada só é completa com indicação explícita de fim', () => {
  assert.equal(inspectReplyRead({ data: { child_comments: {
    child_comments: [], has_more_tail_child_comments: false,
  } } }, 200).complete, true);
  assert.equal(inspectReplyRead({ data: { child_comments: {
    child_comments: [], has_more_tail_child_comments: true,
  } } }, 200).complete, false);
});
