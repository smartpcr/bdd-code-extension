using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Shop.OrderSuite;


[TestClass]
public class Orders
{
#if POSITIONAL
    [TestMethod("places an order")]            // 3.x: displayName ctor; 4.x: binds to [CallerFilePath]!
#else
    #if V3
    [TestMethod("places an order")]
    #else
    [TestMethod(DisplayName = "places an order")]
    #endif
#endif
    [TestCategory("smoke")]
    public void PlacesAnOrder() { }

    #if V3

    [TestMethod("rejects bad quantity")]

    #else

    [TestMethod(DisplayName = "rejects bad quantity")]

    #endif
    [DataRow("rejects [qty=0]", 0, DisplayName = "rejects [qty=0]")]
    [DataRow("rejects [qty=-1]", -1, DisplayName = "rejects [qty=-1]")]
    [TestCategory("validation")]
    public void RejectsBadQuantity(string label, int qty) { Assert.IsTrue(qty <= 0, label); }

    #if V3

    [TestMethod("cancel = refund [full], then (re)check")]

    #else

    [TestMethod(DisplayName = "cancel = refund [full], then (re)check")]

    #endif
    [TestCategory("smoke")]
    [TestCategory("slow")]
    public void CancelRefunds() { }
}
