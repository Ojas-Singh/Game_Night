export async function labApi<T = any>(url: string, body?: object): Promise<T> {
  const response = await fetch('/api/lab' + url, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error ?? 'Request failed');
  return result;
}
