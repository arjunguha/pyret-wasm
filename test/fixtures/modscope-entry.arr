import file("./modscope-a.arr") as A
import file("./modscope-b.arr") as B
print(A.a-read(A.av(7)))
print(B.b-read(B.av(9)))
