using System;
namespace App {
  public class Api {
    public int Handle(int age) {
      if (age >= 18) { return Compute(age); }
      return 0;
    }
    private int Compute(int x) { return x * 2; }
  }
}
