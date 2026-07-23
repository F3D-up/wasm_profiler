struct Pair {
  int a;
  int b;
};

namespace fixture {

__attribute__((noinline)) int twice(int x) {
  return x * 2;
}

__attribute__((noinline)) Pair pack(int x) {
  return Pair{ twice(x), x + 1 };
}

}

extern "C" int pack_a(int x) {
  return fixture::pack(x).a;
}

extern "C" int multi_loop(int n) {
  int acc = 0;
  for (int i = 0; i < n; i++) {
    Pair p = fixture::pack(i);
    acc += p.a + p.b;
  }
  return acc;
}
